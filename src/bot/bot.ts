import { Bot, Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";

import { authorize } from "../middlewares/authorize";
import { OpenAIClient } from "./ai/openai";
import { t } from "./languages";
import { AzureTable } from "../libs/azure-table";
import { IMessageEntity, MessageEntity } from "../entities/messages";

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
	constructor(public botToken: string) { }

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
		this.bot.command("whoiam", async (ctx: Context) => {
			await ctx.reply(`${t.yourAre} ${ctx.from?.first_name} (id: ${ctx.message?.from?.id})`);
		});
		this.bot.api.setMyCommands([
			{ command: 'whoiam', description: 'Who am I' },
		]);
		this.bot.on('message', async (ctx: Context) =>
			this.allMessagesHandler(ctx, this.options.aiClient, this.telegram, this.options.azureTableClient.messages)
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
		return text.replace(new RegExp('${{BOT_TOKEN}}', 'g'), this.options.botToken);
	}

	private async handlePhoto(ctx: BotAppContext, aiClient: OpenAIClient, azureTableMessageClient: AzureTable<IMessageEntity>, photo: { photoUrl: string, caption?: string }) {
		await ctx.reply(`${t.readingImage}...`);
		const incomingMessages = photo.caption ? [photo.caption] : [];
		if (photo.caption) {
			await azureTableMessageClient.insert(await new MessageEntity({
				payload: photo.caption,
				userId: String(ctx.from?.id),
				senderId: String(ctx.from?.id),
				type: 'text',
			}).init());
		}
		await azureTableMessageClient.insert(await new MessageEntity({
			payload: this.maskBotToken(photo.photoUrl, 'mask'),
			userId: String(ctx.from?.id),
			senderId: String(ctx.from?.id),
			type: 'photo',
		}).init());
		const message = await aiClient.chatWithImage('friend', incomingMessages, photo.photoUrl);
		if (!message) {
			await ctx.reply(t.sorryICannotUnderstand);
			return;
		}
		await ctx.reply(message);
		await azureTableMessageClient.insert(await new MessageEntity({
			payload: message,
			userId: String(ctx.from?.id),
			senderId: String(ctx.from?.id),
			type: 'text',
		}).init());
	}

	private async allMessagesHandler(
		ctx: Context,
		aiClient: OpenAIClient,
		telegram: TelegramApiClient,
		azureTableMessageClient: AzureTable<IMessageEntity>
	) {
		// classifying the message type
		const messages: TelegramMessageType = {
			replyToMessage: ctx.message?.reply_to_message?.text,
			text: ctx.message?.text,
			caption: ctx.message?.caption,
			photo: ctx.message?.photo ? (await ctx.getFile()).file_path : undefined,
		}
		if (messages.text === undefined && messages.caption === undefined && messages.photo === undefined) {
			await ctx.reply(t.sorryICannotUnderstandMessageType);
			return;
		}

		const incomingMessage = messages.text || messages.caption;

		if (messages.photo) {
			const photoUrl = telegram.getFileUrl(messages.photo);
			await this.handlePhoto(ctx, aiClient, azureTableMessageClient,{ photoUrl: photoUrl, caption: incomingMessage });
			return;
		}
		if (!incomingMessage || ctx.from?.id === undefined) {
			await ctx.reply(t.sorryICannotUnderstand);
			return;
		}
		await azureTableMessageClient.insert(await new MessageEntity({
			payload: incomingMessage,
			userId: String(ctx.from?.id),
			senderId: String(ctx.from?.id),
			type: 'text',
		}).init());
		await this.handleMessageText(
			ctx,
			aiClient,
			azureTableMessageClient,
			{
				incomingMessage: incomingMessage,
				replyToMessage: messages.replyToMessage,
			});
	}

	private async handleMessageText(
		ctx: Context,
		aiClient: OpenAIClient,
		azureTableMessageClient: AzureTable<IMessageEntity>,
		messageContext: { incomingMessage: string | undefined; replyToMessage: string | undefined; }
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
		const previousMessage = replyToMessage ? [`Previous message: ${replyToMessage}`] : [];
		// For chaining the conversation, we need to keep track of the previous messages
		// Example of chaining the conversation:
		// const message = await aiClient.chat('friend', [ctx.message?.text], ['Previous question: What is your favorite color','Previous response: blue']);

		const messages = await aiClient.chat('friend', [incomingMessage], previousMessage);
		await azureTableMessageClient.insert(await new MessageEntity({
			payload: messages.join('\\n'),
			userId: String(ctx.from?.id),
			senderId: String(0),
			type: 'text',
		}).init());
		let countNoResponse = 0;
		for (const message of messages) {
			if (!message) {
				countNoResponse++;
				continue;
			}
			await delay(100);
			await ctx.reply(message);
		}
		if (countNoResponse === messages.length) {
			await ctx.reply(t.sorryICannotUnderstand);
			return;
		}
	}

	private async saveTextMessages(ctx: BotAppContext, azureTableMessageClient: AzureTable<IMessageEntity>, messages: string[], senderId: number) {
		const messageRowsPromise: Promise<IMessageEntity>[]= [];
		for (let order = 0; order < messages.length; order++) {
			const messageEntity = new MessageEntity({
				payload: messages[order],
				type: 'text',
				senderId: String(senderId),
				userId: String(ctx.from?.id),
			}).init(order);
			messageRowsPromise.push(messageEntity);
		}
		const messageRows = await Promise.all(messageRowsPromise);
		await azureTableMessageClient.insertBatch(messageRows.map((message) => message));
	}

	get instance() {
		return this.bot;
	}
}
