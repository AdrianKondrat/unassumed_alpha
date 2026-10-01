// Pure helpers for the rehearsal JSON routes: error-code to status mapping, an allow-list for what a response
// body may contain, and the content-type gate. No `astro:*`, no `@/`, so scripts/test-rehearsal-persona.mjs can
// import it with `--experimental-strip-types`.

/** HTTP status for a service error code (start, turn, retry and end outcomes). */
export function statusForCode(code: string): number {
  switch (code) {
    case "not_found":
    case "assumption_not_found":
      return 404;
    case "not_active":
    case "not_ended":
    case "reply_pending":
    case "cap_reached":
    case "nothing_to_retry":
    case "assumption_inactive":
      return 409;
    case "ai_failed":
    case "invalid_output":
      return 502;
    default:
      return 500;
  }
}

export interface PublicTurn {
  seq: number;
  question: string;
  reply: string | null;
}

/**
 * The only shape of a turn that may leave the server. Built field by field (never by spreading a row), so a
 * future column, or a scenario accidentally attached to a row, cannot leak into a response or page props.
 */
export function toPublicTurn(turn: { seq: number; question: string; reply: string | null }): PublicTurn {
  return { seq: turn.seq, question: turn.question, reply: turn.reply };
}

/** A turn in the resume state: the public turn plus the founder's own idempotency key (so a client can recognise its send). */
export interface PublicStateTurn extends PublicTurn {
  clientKey: string;
}

/** Field by field, like `toPublicTurn`: lease timestamps and any other column stay on the server. */
export function toPublicStateTurn(turn: {
  seq: number;
  question: string;
  reply: string | null;
  client_key: string;
}): PublicStateTurn {
  return { seq: turn.seq, question: turn.question, reply: turn.reply, clientKey: turn.client_key };
}

/**
 * True for `application/json` (optionally with a charset). The JSON routes insist on it: a cross-site form
 * or `fetch` cannot send this content type without a CORS preflight the app never answers, so it also stops
 * forged cross-site posts that ride on the founder's cookie.
 */
export function isJsonContentType(contentType: string | null): boolean {
  return /^application\/json\s*(;|$)/i.test(contentType?.trim() ?? "");
}
