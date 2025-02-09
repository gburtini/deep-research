import FirecrawlApp, { SearchResponse } from '@mendable/firecrawl-js';
import { generateObject } from 'ai';
import { compact } from 'lodash-es';
import pLimit from 'p-limit';
import { z } from 'zod';

import { o3MiniModel, trimPrompt } from './ai/providers';
import { systemPrompt } from './prompt';

function slugify(text: string, options: { lower: boolean; strict: boolean }) {
  let slug = text
    .toString()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '');

  if (options.lower) {
    slug = slug.toLowerCase();
  }

  if (options.strict) {
    slug = slug.replace(/[^a-z0-9-]/g, '');
  }

  return slug;
}

type ResearchResult = {
  learnings: string[];
  visitedUrls: string[];
  queries: { query: string; researchGoal: string }[];
};

// increase this if you have higher API rate limits
const ConcurrencyLimit = 1;

// Initialize Firecrawl with optional API key and optional base url

const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_KEY ?? '',
  apiUrl: process.env.FIRECRAWL_BASE_URL,
});

// take en user query, return a list of SERP queries
async function generateSerpQueries({
  query,
  numQueries = 3,
  learnings,
}: {
  query: string;
  numQueries?: number;

  // optional, if provided, the research will continue from the last learning
  learnings?: string[];
}) {
  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following prompt from the user, generate a list of SERP queries to research the topic. Return a maximum of ${numQueries} queries, but feel free to return less if the original prompt is clear. Make sure each query is unique and not similar to each other: <prompt>${query}</prompt>\n\n${
      learnings
        ? `Here are some learnings from previous research, use them to generate more specific queries: ${learnings.join(
            '\n',
          )}`
        : ''
    }`,
    schema: z.object({
      queries: z
        .array(
          z.object({
            query: z.string().describe('The SERP query'),
            researchGoal: z
              .string()
              .describe(
                'First talk about the goal of the research that this query is meant to accomplish, then go deeper into how to advance the research once the results are found, mention additional research directions. Be as specific as possible, especially for additional research directions.',
              ),
          }),
        )
        .describe(`List of SERP queries, max of ${numQueries}`),
    }),
  });
  console.log(
    `Created ${res.object.queries.length} queries`,
    res.object.queries,
  );

  return res.object.queries.slice(0, numQueries);
}

async function processSerpResult({
  query,
  result,
  numLearnings = 3,
  numFollowUpQuestions = 3,
}: {
  query: string;
  result: SearchResponse;
  numLearnings?: number;
  numFollowUpQuestions?: number;
}) {
  const contents = compact(result.data.map(item => item.markdown)).map(
    content => trimPrompt(content, 25_000),
  );
  console.log(`Ran ${query}, found ${contents.length} contents`);

  const res = await generateObject({
    model: o3MiniModel,
    abortSignal: AbortSignal.timeout(60_000),
    system: systemPrompt(),
    prompt: `Given the following contents from a SERP search for the query <query>${query}</query>, generate a list of learnings from the contents. Return a maximum of ${numLearnings} learnings, but feel free to return less if the contents are clear. Make sure each learning is unique and not similar to each other. The learnings should be concise and to the point, as detailed and information dense as possible. Make sure to include any entities like people, places, companies, products, things, etc in the learnings, as well as any exact metrics, numbers, or dates. The learnings will be used to research the topic further.\n\n<contents>${contents
      .map(content => `<content>\n${content}\n</content>`)
      .join('\n')}</contents>`,
    schema: z.object({
      learnings: z
        .array(z.string())
        .describe(`List of learnings, max of ${numLearnings}`),
      followUpQuestions: z
        .array(z.string())
        .describe(
          `List of follow-up questions to research the topic further, max of ${numFollowUpQuestions}`,
        ),
    }),
  });
  console.log(
    `Created ${res.object.learnings.length} learnings`,
    res.object.learnings,
  );

  return res.object;
}

export async function writeFinalReport({
  prompt,
  learnings,
  visitedUrls,
  refinementIterates = 1,
}: {
  prompt: string;
  learnings: string[];
  visitedUrls: string[];
  refinementIterates?: number;
}) {
  const learningsString = trimPrompt(
    learnings
      .map(learning => `<learning>\n${learning}\n</learning>`)
      .join('\n'),
    150_000,
  );

  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following prompt from the user, write a final report on the topic using the learnings from research. Make it as as detailed as possible, aim for 3 or more pages, include ALL the learnings from research:\n\n<prompt>${prompt}</prompt>\n\nHere are all the learnings from previous research:\n\n<learnings>\n${learningsString}\n</learnings>`,
    schema: z.object({
      reportMarkdown: z
        .string()
        .describe('Final report on the topic in Markdown'),
    }),
  });

  // Refine the report iteratively
  for (let i = 0; i < refinementIterates; i++) {
    const refinedReport = await refineReport({
      report: res.object.reportMarkdown,
      initialQuery: prompt,
      breadth: 3,
      depth: 2,
    });

    res.object.reportMarkdown = refinedReport;
  }

  // Append the visited URLs section to the report
  const urlsSection = `\n\n## Sources\n\n${visitedUrls.map(url => `- ${url}`).join('\n')}`;
  return res.object.reportMarkdown + urlsSection;
}

export async function generateFileName({
  query,
}: {
  query: string;
}): Promise<string> {
  const res = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following query from the user, suggest a suitable file name for saving the research results. Do NOT include a file extension. The file name should be concise, descriptive, and relevant to the query: <query>${query}</query>`,
    schema: z.object({
      fileName: z
        .string()
        .describe('Suggested file name for the research results'),
    }),
  });

  return slugify(res.object.fileName, { lower: true, strict: true });
}

const MAX_RETRIES = 5;
const INITIAL_BACKOFF = 5000; // 5 second

async function firecrawlSearchWithRetry(
  query: string,
  retries = MAX_RETRIES,
): Promise<SearchResponse> {
  let attempt = 0;
  let backoff = INITIAL_BACKOFF;

  while (attempt < retries) {
    try {
      await new Promise(resolve => setTimeout(resolve, INITIAL_BACKOFF));

      return await firecrawl.search(query, {
        timeout: 15000,
        limit: 5,
        scrapeOptions: { formats: ['markdown'] },
      });
    } catch (e: any) {
      if (e.message && e.message.includes('Timeout')) {
        console.error(`Timeout error running query: ${query}: `, e);
      } else {
        console.error(`Error running query: ${query}: `, e);
      }

      attempt++;
      if (attempt < retries) {
        console.log(`Retrying query: ${query} in ${backoff}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        backoff *= 2; // Exponential backoff
      } else {
        throw e;
      }
    }
  }

  throw new Error(`Failed to run query: ${query}`);
}

export async function deepResearch({
  query,
  breadth,
  depth,
  learnings = [],
  visitedUrls = [],
}: {
  query: string;
  breadth: number;
  depth: number;
  learnings?: string[];
  visitedUrls?: string[];
}): Promise<ResearchResult> {
  const serpQueries = await generateSerpQueries({
    query,
    learnings,
    numQueries: breadth,
  });
  const limit = pLimit(ConcurrencyLimit);

  const results = await Promise.all(
    serpQueries.map(serpQuery =>
      limit(async () => {
        try {
          const result = await firecrawlSearchWithRetry(serpQuery.query);

          // Collect URLs from this search
          const newUrls = compact(result.data.map(item => item.url));
          const newBreadth = Math.ceil(breadth / 2);
          const newDepth = depth - 1;

          const newLearnings = await processSerpResult({
            query: serpQuery.query,
            result,
            numFollowUpQuestions: newBreadth,
          });
          const allLearnings = [...learnings, ...newLearnings.learnings];
          const allUrls = [...visitedUrls, ...newUrls];

          if (newDepth > 0) {
            console.log(
              `Researching deeper, breadth: ${newBreadth}, depth: ${newDepth}`,
            );

            const nextQuery = `
            Previous research goal: ${serpQuery.researchGoal}
            Follow-up research directions: ${newLearnings.followUpQuestions.map(q => `\n${q}`).join('')}
          `.trim();

            return deepResearch({
              query: nextQuery,
              breadth: newBreadth,
              depth: newDepth,
              learnings: allLearnings,
              visitedUrls: allUrls,
            });
          } else {
            return {
              learnings: allLearnings,
              visitedUrls: allUrls,
              queries: serpQueries,
            };
          }
        } catch (e: any) {
          if (e.message && e.message.includes('Timeout')) {
            console.error(
              `Timeout error running query: ${serpQuery.query}: `,
              e,
            );
          } else {
            console.error(`Error running query: ${serpQuery.query}: `, e);
          }
          return {
            learnings: [],
            visitedUrls: [],
            queries: [],
          };
        }
      }),
    ),
  );

  return {
    learnings: [...new Set(results.flatMap(r => r.learnings))],
    visitedUrls: [...new Set(results.flatMap(r => r.visitedUrls))],
    queries: serpQueries,
  };
}

export async function refineReport({
  report,
  initialQuery,
  breadth,
  depth,
}: {
  report: string;
  initialQuery: string;
  breadth: number;
  depth: number;
}): Promise<string> {
  console.log(`Refining report with deep research...`);

  // Step 1: Generate criticism
  const criticismRes = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following report, provide a detailed criticism highlighting any gaps, weaknesses, or areas for further research. Be as specific as possible:\n\n<report>${report}</report>`,
    schema: z.object({
      criticism: z.string().describe('Detailed criticism of the report'),
    }),
  });

  const criticism = criticismRes.object.criticism;
  console.log(`Generated criticism:\n${criticism}`);

  // Step 2: Generate follow-up questions based on criticism
  const followUpQuestionsRes = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following criticism, generate follow-up questions to address the gaps and weaknesses identified. Return a maximum of ${breadth} questions:\n\n<criticism>${criticism}</criticism>`,
    schema: z.object({
      questions: z
        .array(z.string())
        .describe('Follow-up questions based on criticism'),
    }),
  });

  const followUpQuestions = followUpQuestionsRes.object.questions.slice(
    0,
    breadth,
  );
  console.log(
    `Generated follow-up questions:\n${followUpQuestions.join('\n')}`,
  );

  // Step 3: Conduct deep research based on follow-up questions
  const combinedQuery = `
Initial Query: ${initialQuery}
Criticism: ${criticism}
Follow-up Questions:
${followUpQuestions.map(q => `Q: ${q}`).join('\n')}
`;

  const { learnings, visitedUrls } = await deepResearch({
    query: combinedQuery,
    breadth,
    depth,
  });

  console.log(`\n\nNew Learnings:\n\n${learnings.join('\n')}`);
  console.log(
    `\n\nNew Visited URLs (${visitedUrls.length}):\n\n${visitedUrls.join('\n')}`,
  );

  // Step 4: Revise the report with new learnings
  const revisedReportRes = await generateObject({
    model: o3MiniModel,
    system: systemPrompt(),
    prompt: `Given the following initial report and new learnings, revise the report to address the criticism and incorporate the new information. Make it as detailed as possible:\n\n<report>${report}</report>\n\n<learnings>${learnings.join('\n')}</learnings>`,
    schema: z.object({
      revisedReport: z
        .string()
        .describe('Revised report incorporating new learnings'),
    }),
  });

  const revisedReport = revisedReportRes.object.revisedReport;
  console.log(`Revised Report:\n${revisedReport}`);

  return revisedReport;
}
