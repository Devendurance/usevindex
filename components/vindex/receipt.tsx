const rows = [
  ["NETWORK", "Base Sepolia"],
  ["PROTOCOL", "Aave V3"],
  ["POSITION", "USDC — Aave Base Sepolia test asset"],
  ["POLICY", "Standard | Protection Drill / High Sensitivity"],
  ["TRIGGER", "—"],
  ["CONSENSUS", "—"],
  ["SIMULATION", "—"],
  ["ACTION", "Aave withdraw → Safe Wallet"],
  ["AMOUNT", "—"],
  ["DESTINATION", "—"],
  ["KEEPERHUB", "—"],
  ["TRANSACTION", "—"],
  ["BLOCK", "—"],
  ["GAS", "—"],
  ["PRE-BALANCE", "—"],
  ["POST-BALANCE", "—"],
  ["VERIFICATION", "—"],
  ["STATUS", "—"],
  ["AUDIT", "—"],
];

export function Receipt({ preview = true }: { preview?: boolean }) {
  return (
    <div className="receipt outline-panel">
      <div className="receipt__topline">
        <span className="data-label">{preview ? "SIMULATION ONLY" : "VINDEX RESCUE"}</span>
        <span className="receipt__stamp">NO LIVE RECORD</span>
      </div>
      <h2>VINDEX RESCUE / —</h2>
      <div className="receipt__rows">
        {rows.map(([label, value]) => (
          <div className="receipt__row" key={label}>
            <span>{label}</span>
            <strong className={value === "—" ? "empty-dash" : ""}>{value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
