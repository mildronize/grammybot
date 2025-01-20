import { Bot, Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

import { authorize } from '../middlewares/authorize';
import { ChatMode, OpenAIClient, PreviousMessage } from './ai/openai';
import { t } from './languages';
import { AzureTable } from '../libs/azure-table';
import { IMessageEntity, MessageEntity } from '../entities/messages';
import { ODataExpression } from 'ts-odata-client';
import telegramifyMarkdown from 'telegramify-markdown';

type BotAppContext = Context;

export interface TelegramMessageType {
  /**
   * Incoming reply_to_message, when the user reply existing message
   * Use this for previous message context
   */
  replyToMessage?: string;
  /**
   * Incoming text message
   */
  text?: string;
  /**
   * Incoming caption message (with photo)
   */
  caption?: string;
  /**
   * Incoming photo file_path
   */
  photo?: string;
  /**
   * Incoming audio file_path
   */
  // audio?: string;
}

export interface BotAppOptions {
  botToken: string;
  azureTableClient: {
    messages: AzureTable<IMessageEntity>;
  };
  aiClient: OpenAIClient;
  botInfo?: UserFromGetMe;
  allowUserIds?: number[];
  protectedBot?: boolean;
}

export class TelegramApiClient {
  baseUrl = 'https://api.telegram.org';
  constructor(public botToken: string) {}

  async getMe() {
    const response = await fetch(`${this.baseUrl}/bot${this.botToken}/getMe`);
    if (!response.ok) {
      throw new Error(`Failed to get the bot info: ${response.statusText}`);
    }
    const data = await response.json();
    return data;
  }

  /**
   * Get Download URL for the file
   *
   * @ref https://core.telegram.org/bots/api#getfile
   * @param filePath
   * @returns
   */

  getFileUrl(filePath: string): string {
    return `${this.baseUrl}/file/bot${this.botToken}/${filePath}`;
  }
}

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class BotApp {
  private bot: Bot<BotAppContext>;
  private telegram: TelegramApiClient;
  private protectedBot: boolean;
  constructor(public options: BotAppOptions) {
    this.bot = new Bot<BotAppContext>(options.botToken, {
      botInfo: options.botInfo,
    });
    this.telegram = new TelegramApiClient(options.botToken);
    this.protectedBot = options.protectedBot ?? true;
  }

  init() {
    console.log('BotApp init');
    if (this.protectedBot === true) {
      this.bot.use(authorize(this.options.allowUserIds ?? []));
    }
    this.bot.command('whoiam', async (ctx: Context) => {
      await ctx.reply(`${t.yourAre} ${ctx.from?.first_name} (id: ${ctx.message?.from?.id})`);
    });
    this.bot.command('ai', async (ctx) => {
      // With the `ai` command, the user can chat with the AI using Full Response Mode
      const incomingMessage = ctx.match;
      return this.handleMessageText(
        ctx,
        this.options.aiClient,
        this.options.azureTableClient.messages,
        {
          incomingMessage,
        },
        'default',
      );
    });
    this.bot.api.setMyCommands([
      { command: 'whoiam', description: 'Who am I' },
      { command: 'ai', description: 'Chat With AI using Full Response' },
    ]);
    this.bot.on('message', async (ctx: Context) =>
      this.allMessagesHandler(ctx, this.options.aiClient, this.telegram, this.options.azureTableClient.messages, 'natural'),
    );
    this.bot.catch((err) => {
      console.error('Bot error', err);
    });
    return this;
  }

  async start() {
    await this.bot.start({
      onStart(botInfo) {
        console.log(new Date(), 'Bot starts as', botInfo.username);
      },
    });
  }

  private maskBotToken(text: string, action: 'mask' | 'unmask') {
    if (action === 'mask') return text.replace(new RegExp(this.options.botToken, 'g'), '${{BOT_TOKEN}}');
    return text.replaceAll('${{BOT_TOKEN}}', this.options.botToken);
  }

  private async handlePhoto(
    ctx: BotAppContext,
    aiClient: OpenAIClient,
    azureTableMessageClient: AzureTable<IMessageEntity>,
    photo: { photoUrl: string; caption?: string },
  ) {
    await ctx.reply(`${t.readingImage}...`);
    const incomingMessages = photo.caption ? [photo.caption] : [];
    if (photo.caption) {
      await azureTableMessageClient.insert(
        await new MessageEntity({
          payload: photo.caption,
          userId: String(ctx.from?.id),
          senderId: String(ctx.from?.id),
          type: 'text',
        }).init(),
      );
    }
    await azureTableMessageClient.insert(
      await new MessageEntity({
        payload: this.maskBotToken(photo.photoUrl, 'mask'),
        userId: String(ctx.from?.id),
        senderId: String(ctx.from?.id),
        type: 'photo',
      }).init(),
    );
    const message = await aiClient.chatWithImage('multiAgent', incomingMessages, photo.photoUrl);
    if (!message) {
      await ctx.reply(t.sorryICannotUnderstand);
      return;
    }
    await ctx.reply(message);
    await azureTableMessageClient.insert(
      await new MessageEntity({
        payload: message,
        userId: String(ctx.from?.id),
        senderId: String(ctx.from?.id),
        type: 'text',
      }).init(),
    );
  }

  private async allMessagesHandler(
    ctx: Context,
    aiClient: OpenAIClient,
    telegram: TelegramApiClient,
    azureTableMessageClient: AzureTable<IMessageEntity>,
    chatMode: ChatMode,
  ) {
    // classifying the message type
    const messages: TelegramMessageType = {
      replyToMessage: ctx.message?.reply_to_message?.text,
      text: ctx.message?.text,
      caption: ctx.message?.caption,
      photo: ctx.message?.photo ? (await ctx.getFile()).file_path : undefined,
    };
    if (messages.text === undefined && messages.caption === undefined && messages.photo === undefined) {
      await ctx.reply(t.sorryICannotUnderstandMessageType);
      return;
    }

    const incomingMessage = messages.text || messages.caption;

    if (messages.photo) {
      const photoUrl = telegram.getFileUrl(messages.photo);
      await this.handlePhoto(ctx, aiClient, azureTableMessageClient, { photoUrl: photoUrl, caption: incomingMessage });
      return;
    }
    if (!incomingMessage || ctx.from?.id === undefined) {
      await ctx.reply(t.sorryICannotUnderstand);
      return;
    }
    await this.handleMessageText(
      ctx,
      aiClient,
      azureTableMessageClient,
      {
        incomingMessage: incomingMessage,
        replyToMessage: messages.replyToMessage,
      },
      chatMode,
    );
  }

  private async handleMessageText(
    ctx: Context,
    aiClient: OpenAIClient,
    azureTableMessageClient: AzureTable<IMessageEntity>,
    messageContext: { incomingMessage: string | undefined; replyToMessage?: string },
    chatMode: ChatMode,
  ) {
    const { incomingMessage, replyToMessage } = messageContext;
    if (!aiClient) {
      await ctx.reply(`${t.sorryICannotUnderstand} (aiClient is not available)`);
      return;
    }
    if (!incomingMessage) {
      await ctx.reply('Please send a text message');
      return;
    }

    // Save the incoming message to the database
    await azureTableMessageClient.insert(
      await new MessageEntity({
        payload: incomingMessage,
        userId: String(ctx.from?.id),
        senderId: String(ctx.from?.id),
        type: 'text',
      }).init(),
    );

    // Step 1: add inthe replyToMessage to the previousMessage in first chat
    const previousMessage: PreviousMessage[] = replyToMessage ? [{ type: 'text', content: replyToMessage }] : [];
    // Step 2: Load previous messages from the database

    if (ctx.from?.id) {
      let countMaxPreviousMessage = aiClient.previousMessageLimit;
      const query = ODataExpression.forV4<IMessageEntity>()
        .filter((p) => p.userId.$equals(String(ctx.from?.id)))
        .build();
      for await (const entity of azureTableMessageClient.list(query)) {
        if (countMaxPreviousMessage <= 0) {
          break;
        }
				const content = entity.type === 'photo' ? this.maskBotToken(entity.payload, 'unmask') : entity.payload;
        previousMessage.push({ type: entity.type, content });
        countMaxPreviousMessage--;
      }
    } else {
      console.log(`userId is not available, skipping loading previous messages`);
    }
    previousMessage.reverse();
    // Step 3: Chat with AI
    const messages = await aiClient.chat('multiAgent', chatMode, [incomingMessage], previousMessage);
    await azureTableMessageClient.insert(
      await new MessageEntity({
        payload: messages.join(' '),
        userId: String(ctx.from?.id),
        senderId: String(0),
        type: 'text',
      }).init(),
    );
    let countNoResponse = 0;
    for (const message of messages) {
      if (!message) {
        countNoResponse++;
        continue;
      }
      await delay(100);
      await ctx.reply(telegramifyMarkdown(message, 'escape'), { parse_mode: 'MarkdownV2' });
    }
    if (countNoResponse === messages.length) {
      await ctx.reply(t.sorryICannotUnderstand);
      return;
    }
  }

  get instance() {
    return this.bot;
  }
}
