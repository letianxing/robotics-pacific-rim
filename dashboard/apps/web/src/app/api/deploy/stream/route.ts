import {
	parseDeployInput,
	streamDeployPackage,
} from "@dashboard/api/routers/deploy";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { withEvlog } from "@/lib/evlog";

export const runtime = "nodejs";

type DeployStreamEvent =
	| { text: string; type: "chunk" }
	| { message: string; type: "error" }
	| { type: "done" };

const encoder = new TextEncoder();

function encodeEvent(event: DeployStreamEvent): Uint8Array {
	return encoder.encode(`${JSON.stringify(event)}\n`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function handler(req: NextRequest): Promise<Response> {
	let input: ReturnType<typeof parseDeployInput>;
	try {
		input = parseDeployInput(await req.json());
	} catch (error) {
		const message =
			error instanceof z.ZodError
				? z.prettifyError(error)
				: errorMessage(error);
		return Response.json({ message }, { status: 400 });
	}

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: DeployStreamEvent) => {
				controller.enqueue(encodeEvent(event));
			};

			try {
				await streamDeployPackage(input, (text) => {
					send({ text, type: "chunk" });
				});
				send({ type: "done" });
			} catch (error) {
				send({ message: errorMessage(error), type: "error" });
			} finally {
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"Content-Type": "application/x-ndjson; charset=utf-8",
		},
	});
}

export const POST = withEvlog(handler);
