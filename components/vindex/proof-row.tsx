import { ArrowDownRight } from "lucide-react";

const points = [
  { number: "01", title: "WATCH", body: "Independent signals monitor the position." },
  { number: "02", title: "CONFIRM", body: "No exit on one noisy alert." },
  { number: "03", title: "VERIFY", body: "KeeperHub execution and safe-wallet proof." },
];

export function ProofRow() {
  return (
    <div className="proof-row">
      {points.map(({ number, title, body }) => (
        <div className="proof-point" key={title}>
          <span className="arrow-tile"><ArrowDownRight size={17} strokeWidth={1.8} aria-hidden="true" /></span>
          <div>
            <p className="data-label">{number}. {title}</p>
            <p className="proof-point__body">{body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
