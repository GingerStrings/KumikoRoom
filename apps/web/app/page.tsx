import { HomeNavigation } from "../src/components/HomeNavigation";
import { getConnectionStatus } from "../src/lib/connectionStatus";

export default function HomePage() {
  return <HomeNavigation connectionStatus={getConnectionStatus()} />;
}
