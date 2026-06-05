import type { RoomState } from "../api/types";

export const DEFAULT_ROOM_STATE: RoomState = {
  appName: "KumikoRoom",
  roomName: "陪伴房间",
  character: {
    displayName: "黄前久美子",
    romanizedName: "Kumiko Oumae",
    expression: "listening",
    statusText: "正在听你今天想说的音乐"
  },
  music: {
    currentTrackTitle: null,
    currentArtist: null,
    listeningMood: "还没记录"
  },
  diarySummary: "今天还没有写听歌日记。",
  inspirationCount: 0,
  studio: {
    label: "创作资料室",
    route: "/studio",
    unfinishedCount: 0
  }
};

export function getIdleLine(state: RoomState): string {
  const track = state.music.currentTrackTitle;
  if (track) {
    return `今天在听《${track}》吗？我可以陪你记下来。`;
  }

  return "今天想从哪首歌开始聊？";
}
