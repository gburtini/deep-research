import fsSync from 'fs';
import * as fs from 'fs/promises';
import * as readline from 'readline';

import {
  deepResearch,
  generateFileName,
  writeFinalReport,
} from './deep-research';
import { generateFeedback } from './feedback';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Helper function to get user input
function askQuestion(query: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(query, answer => {
      resolve(answer);
    });
  });
}

// run the agent
async function run() {
  // Get initial query
  const initialQuery = await askQuestion('What would you like to research? ');

  // Get breath and depth parameters
  const breadth =
    parseInt(
      await askQuestion(
        'Enter research breadth (recommended 2-10, default 4): ',
      ),
      10,
    ) || 4;
  const depth =
    parseInt(
      await askQuestion('Enter research depth (recommended 1-5, default 2): '),
      10,
    ) || 2;

  console.log(`Creating research plan...`);

  // Generate follow-up questions
  const followUpQuestions = await generateFeedback({
    query: initialQuery,
  });

  console.log(
    '\nTo better understand your research needs, please answer these follow-up questions:',
  );

  // Collect answers to follow-up questions
  const answers: string[] = [];
  for (const question of followUpQuestions) {
    const answer = await askQuestion(`\n${question}\nYour answer: `);
    answers.push(answer);
  }

  // Combine all information for deep research
  const combinedQuery = `
Initial Query: ${initialQuery}
Follow-up Questions and Answers:
${followUpQuestions.map((q, i) => `Q: ${q}\nA: ${answers[i]}`).join('\n')}
`;

  console.log('\nResearching your topic...');

  const { learnings, visitedUrls, queries } = await deepResearch({
    query: combinedQuery,
    breadth,
    depth,
  });

  console.log(`\n\nLearnings:\n\n${learnings.join('\n')}`);
  console.log(
    `\n\nVisited URLs (${visitedUrls.length}):\n\n${visitedUrls.join('\n')}`,
  );
  console.log('Writing final report...');

  const { steps, report } = await writeFinalReport({
    prompt: combinedQuery,
    learnings,
    visitedUrls,
  });

  const metadata = `
  # Research Metadata
  - Initial Query: ${initialQuery}
  - Breadth: ${breadth}
  - Depth: ${depth}
  - Follow-up Questions and Answers:
  ${followUpQuestions.map((q, i) => `  - Q: ${q}\n    A: ${answers[i]}`).join('\n')}
  - Research Plan (${queries.length}):
  ${queries.map(q => `  - ${q.researchGoal} (${q.query})`).join('\n')}
  - Learnings (${learnings.length}):
  ${learnings.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}
  - Visited URLs (${visitedUrls.length}):
  ${visitedUrls.map((u, i) => `  ${i + 1}. ${u}`).join('\n')}

  # Refinement Steps
  ${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n\n')}
  `;
  let fileName =
    (await generateFileName({ query: combinedQuery })) ??
    new Date().toISOString();

  // Save report to file
  if (!fsSync.existsSync('output')) {
    await fs.mkdir('output');
  }

  let originalFileName = fileName;
  let i = 1;
  while (fsSync.existsSync(`output/${fileName}.md`)) {
    fileName = `${originalFileName}-${i}`;
    i++;

    if (i > 100) {
      console.log(report + metadata);
      console.error('Error: Could not save report. Please try again.');
      process.exit(1);
    }
  }

  await fs.writeFile(`output/${fileName}.md`, report + metadata, 'utf-8');

  console.log(`\n\nFinal Report:\n\n${report}`);
  console.log(`\nReport has been saved to ${fileName}.md`);
  rl.close();
}

run().catch(console.error);
