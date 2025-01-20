import {  z } from "zod";

export const multiAgentResponseSchema = z.object({
	agentType: z.union([z.literal('Friend'), z.literal('Expense Tracker'), z.literal('Note')]),
	dateTimeUtc: z.string().optional(),
	message: z.string().optional(),
	// For Expense Tracker
	amount: z.number().optional(),
	category: z.string().optional(),
	memo: z.string().optional(),
	// For Note
	// Also use note
});

// export const multiAgentResponseSchema = z.union([
// 	z.object({
// 		agentType: z.literal('Friend'),
// 		message: z.string(),
// 	}),
// 	z.object({
// 		agentType: z.literal('Expense Tracker'),
// 		amount: z.number().optional(),
// 		category: z.string().optional(),
// 		date: z.date().optional(),
// 	}),
// 	z.object({
// 		agentType: z.literal('Note Taker'),
// 		note: z.string().optional(),
// 		date: z.date().optional(),
// 	}),
// ]);


