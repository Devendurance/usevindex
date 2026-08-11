export function RouteDiagram({ active = "Simulation pending" }: { active?: string }) {
  return (
    <div className="route-diagram" aria-label="Supported exit path">
      <div><span>Position</span><small>KeeperHub wallet</small></div>
      <span className="route-diagram__arrow" aria-hidden="true">→</span>
      <div><span>Aave withdrawal</span><small>{active}</small></div>
      <span className="route-diagram__arrow" aria-hidden="true">→</span>
      <div><span>Safe wallet</span><small>Verification pending</small></div>
    </div>
  );
}
