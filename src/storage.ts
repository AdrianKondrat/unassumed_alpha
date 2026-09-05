/**
 * D1 persistence for waitlist signups.
 *
 * The point of this file is ordering: the row is written *before* Resend is
 * called. An email provider outage then costs a notification, which is
 * recoverable from the table, rather than a signup, which is not recoverable
 * from anywhere.
 *
 * Every function here degrades rather than throws. A database problem must
 * never be the reason a founder's address is lost, so a failed write is logged
 * and the caller falls through to sending the email anyway.
 */

export type StoreResult =
  | { status: "created"; id: string }
  | { status: "duplicate" }
  | { status: "unavailable" };

export interface SignupRecord {
  email: string;
  source: string;
  country: string;
  userAgent: string;
  receivedAt: string;
}

/**
 * Inserts a signup, or reports that the address is already on the list.
 *
 * `ON CONFLICT DO NOTHING` against the unique index does the deduplication in
 * one statement — a prior SELECT would leave a window in which two concurrent
 * submissions of the same address both pass the check.
 */
export async function storeSignup(
  db: D1Database | undefined,
  record: SignupRecord,
): Promise<StoreResult> {
  if (!db) return { status: "unavailable" };

  const id = crypto.randomUUID();

  try {
    const result = await db
      .prepare(
        `INSERT INTO waitlist_signups
           (id, email, email_normalised, source, country, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (email_normalised) DO NOTHING`,
      )
      .bind(
        id,
        record.email,
        record.email.toLowerCase(),
        record.source,
        record.country,
        record.userAgent,
        record.receivedAt,
      )
      .run();

    // `changes` is 0 when the conflict clause suppressed the insert.
    return result.meta.changes > 0 ? { status: "created", id } : { status: "duplicate" };
  } catch (cause) {
    console.error("d1_store_failed", {
      error: cause instanceof Error ? cause.message : String(cause),
      email: record.email,
    });
    return { status: "unavailable" };
  }
}

/**
 * Stamps a row once its email has actually gone out. Best effort by design:
 * the signup is already safe, and failing the request now would be worse than
 * a null column. `notified_at IS NULL` is the recovery query after an outage.
 */
export async function markSent(
  db: D1Database | undefined,
  id: string,
  column: "notified_at" | "confirmed_at",
): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(`UPDATE waitlist_signups SET ${column} = ? WHERE id = ?`)
      .bind(new Date().toISOString(), id)
      .run();
  } catch (cause) {
    console.error("d1_mark_failed", { column, id, error: String(cause) });
  }
}
