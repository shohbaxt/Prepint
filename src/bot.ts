import { Bot, InlineKeyboard } from 'grammy';
import dotenv from 'dotenv';
import { pool } from "./db/index";
dotenv.config();

const bot = new Bot(process.env.BOT_TOKEN!);

// --- helpers ---

async function getOrCreateUser(telegramId: number, username: string | undefined) {
  const res = await pool.query(
    `INSERT INTO users (telegram_id, username)
     VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET username = $2
     RETURNING id`,
    [telegramId, username ?? null]
  );
  return res.rows[0].id as number;
}

async function getShuffledQuestions(): Promise<number[]> {
  const res = await pool.query(`SELECT id FROM questions`);
  const ids: number[] = res.rows.map((r) => r.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  return ids;
}

async function startSession(userId: number) {
  const order = await getShuffledQuestions();
  await pool.query(`DELETE FROM user_progress WHERE user_id = $1`, [userId]);
  await pool.query(
    `INSERT INTO user_progress (user_id, question_order, current_index)
     VALUES ($1, $2, 0)`,
    [userId, order]
  );
  return order;
}

async function getProgress(userId: number) {
  const res = await pool.query(
    `SELECT * FROM user_progress WHERE user_id = $1`,
    [userId]
  );
  return res.rows[0] ?? null;
}

async function getQuestion(questionId: number) {
  const res = await pool.query(`SELECT * FROM questions WHERE id = $1`, [questionId]);
  return res.rows[0];
}

async function sendQuestion(chatId: number, userId: number) {
  const progress = await getProgress(userId);
  if (!progress) return;

  const { question_order, current_index } = progress;

  if (current_index >= question_order.length) {
    const keyboard = new InlineKeyboard().text('🔄 Start over', 'start_over');
    await bot.api.sendMessage(
      chatId,
      `🎉 Congrats! You reviewed all ${question_order.length} questions!\n\nTap *Start over* to shuffle and begin again.`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
    return;
  }

  const questionId = question_order[current_index];
  const q = await getQuestion(questionId);

  await bot.api.sendPoll(chatId, q.question, [q.option_a, q.option_b, q.option_c], {
    type: 'quiz',
    correct_option_ids: [['A', 'B', 'C'].indexOf(q.correct_option)],
    explanation: q.explanation.slice(0, 200),
    is_anonymous: false,
  });
}

// --- handlers ---

bot.command('start', async (ctx) => {
  const telegramId = ctx.from!.id;
  const username = ctx.from?.username;
  await getOrCreateUser(telegramId, username);

  const keyboard = new InlineKeyboard().text('🚀 Start', 'start_quiz');
  await ctx.reply(
    `👋 Welcome to *Prepint!*\n\nThis bot will help you prepare for your web developer job interview.\n\nYou'll go through *196 questions* covering HTML, CSS, JavaScript, TypeScript, DOM and React — one by one.\n\nReady?`,
    { parse_mode: 'Markdown', reply_markup: keyboard }
  );
});

bot.callbackQuery('start_quiz', async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = ctx.from.id;
  const userId = await getOrCreateUser(telegramId, ctx.from.username);
  await startSession(userId);
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  await sendQuestion(telegramId, userId);
});

bot.callbackQuery('start_over', async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = ctx.from.id;
  const userId = await getOrCreateUser(telegramId, ctx.from.username);
  await startSession(userId);
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  await sendQuestion(telegramId, userId);
});

bot.on('poll_answer', async (ctx) => {
  const telegramId = ctx.pollAnswer.user!.id;

  const userRes = await pool.query(
    `SELECT id FROM users WHERE telegram_id = $1`,
    [telegramId]
  );
  if (!userRes.rows[0]) return;
  const userId = userRes.rows[0].id;

  const progress = await getProgress(userId);
  if (!progress) return;

  const { question_order, current_index } = progress;
  const questionId = question_order[current_index];
  const q = await getQuestion(questionId);

  const chosenIndex = ctx.pollAnswer.option_ids[0];
  const correctIndex = ['A', 'B', 'C'].indexOf(q.correct_option);

  if (chosenIndex !== correctIndex) {
    await bot.api.sendMessage(
      telegramId,
      `📹 Watch explanation: ${q.video_url}`
    );
  }

  await pool.query(
    `UPDATE user_progress SET current_index = current_index + 1 WHERE user_id = $1`,
    [userId]
  );

  await sendQuestion(telegramId, userId);
});

bot.catch((err) => {
  console.error('Bot error:', err);
});

bot.start();
console.log('Bot is running 🤖');