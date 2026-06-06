import { RoomShell } from "../../src/components/RoomShell";
import { getConnectionStatus } from "../../src/lib/connectionStatus";
import { DEFAULT_ROOM_STATE } from "../../src/lib/roomState";

export default function RoomPage() {
  return <RoomShell initialState={DEFAULT_ROOM_STATE} connectionStatus={getConnectionStatus()} />;
}
