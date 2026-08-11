import type { ProtectionState } from "@/lib/vindex/types";

const states = ["WATCHING", "ELEVATED", "CONFIRMING", "EVACUATING", "PROTECTED"];

export function StateRail({ active = "CONFIRMING" }: { active?: ProtectionState | "EVACUATING" }) {
  return (
    <div className="state-rail" aria-label="Protection state sequence">
      {states.map((state, index) => (
        <div className={`state-rail__item${active === state ? " is-active" : ""}`} key={state}>
          <span className="state-rail__number">0{index + 1}</span>
          <span>{state}</span>
          {index < states.length - 1 && <span className="state-rail__arrow" aria-hidden="true">→</span>}
        </div>
      ))}
    </div>
  );
}
