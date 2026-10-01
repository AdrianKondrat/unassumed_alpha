import type { APIRoute } from "astro";
import { z } from "zod";
import { questionSchema } from "@/lib/services/rehearsal-persona";
import { sendTurn } from "@/lib/services/rehearsal-service";
import { json, prepare, readJsonBody, turnResponse } from "@/lib/services/rehearsal-route";

export const prerender = false;

// Sends the founder's next question and returns the persona's reply. The question is saved before the AI is
// called, so a failed reply answers 502 with the saved turn and the UI offers Retry.
export const POST: APIRoute = async (context) => {
  const ready = prepare(context);
  if (ready instanceof Response) return ready;

  const body = await readJsonBody(context.request);
  if (!body.ok) return body.response;
  const input = z.object({ question: questionSchema }).safeParse(body.body);
  if (!input.success) {
    return json(400, { error: "invalid", message: input.error.issues[0]?.message ?? "Write a question first" });
  }

  return turnResponse(await sendTurn({ ...ready, question: input.data.question }));
};
