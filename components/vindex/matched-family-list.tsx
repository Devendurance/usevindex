import { formatFamilyLabel } from "@/lib/signal-family-labels";

type MatchedFamily = {
  family: string;
  reason: string;
};

export function MatchedFamilyList({ families }: { families: MatchedFamily[] }) {
  return (
    <ul className="matched-family-list">
      {families.map((family) => (
        <li className="matched-family-row" key={family.family}>
          <strong className="matched-family-row__title">{formatFamilyLabel(family.family)}</strong>
          <span className="matched-family-row__reason">{family.reason}</span>
        </li>
      ))}
    </ul>
  );
}
