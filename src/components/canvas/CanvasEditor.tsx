import { useClaimEditor } from "@/components/hooks/useClaimEditor";
import type { CanvasBlockKey, PublicClaim } from "@/types";
import { AddClaim } from "./AddClaim";
import { ClaimItem } from "./ClaimItem";

interface CanvasEditorProps {
  blocks: { key: CanvasBlockKey; label: string; hint: string }[];
  initialClaims: PublicClaim[];
  /** Mirror the server's CLAIM_MAX_LENGTH and BLOCK_CLAIM_CAP, passed in so this island imports no server modules. */
  claimMaxLength: number;
  blockCap: number;
}

/** The nine blocks with their claims: edit, add and delete by hand. Saves are explicit and revision-checked. */
export function CanvasEditor({ blocks, initialClaims, claimMaxLength, blockCap }: CanvasEditorProps) {
  const editor = useClaimEditor(initialClaims);

  return (
    <div>
      <p role="status" aria-live="polite" className="sr-only">
        {editor.announcement}
      </p>
      <ol className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {blocks.map((block, index) => {
          const blockClaims = editor.claims
            .filter((claim) => claim.block === block.key)
            .sort((a, b) => a.position - b.position);
          return (
            <li key={block.key} className="card-flat flex flex-col gap-3 p-5" data-block={block.key}>
              <div>
                <div className="text-ink-mute font-mono text-xs font-bold tracking-[0.16em]">
                  {String(index + 1).padStart(2, "0")}
                </div>
                <h3 className="disp mt-1 text-2xl">{block.label}</h3>
                <p className="mono-note mt-1">{block.hint}</p>
              </div>
              {blockClaims.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-4" aria-label={`${block.label} claims`}>
                  {blockClaims.map((claim) => (
                    <ClaimItem key={claim.id} claim={claim} editor={editor} maxLength={claimMaxLength} />
                  ))}
                </ul>
              ) : (
                <p className="text-ink-soft text-sm">Nothing here yet.</p>
              )}
              <AddClaim
                block={block.key}
                label={block.label}
                editor={editor}
                maxLength={claimMaxLength}
                full={blockClaims.length >= blockCap}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}
