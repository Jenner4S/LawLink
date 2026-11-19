import { listEthicalWalls, listWallTargets } from "@/server/ethical-walls/actions";

import { EthicalWallsView } from "./_components/ethical-walls-view";

export default async function EthicalWallsPage() {
  const [walls, targets] = await Promise.all([listEthicalWalls(), listWallTargets()]);
  return <EthicalWallsView walls={walls} targets={targets} />;
}
