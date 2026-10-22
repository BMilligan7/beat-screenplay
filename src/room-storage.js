const ROOM_API_PREFIX = "/api/rooms/";

function roomHeaders(key, includeJson = false) {
  return {
    authorization: `Bearer ${key}`,
    ...(includeJson ? { "content-type": "application/json" } : {}),
  };
}

async function roomJson(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) throw new Error("Room storage is unavailable");
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || `Room storage failed (${response.status})`);
  return payload;
}

export function roomSnapshotSignature(draftName, blocks) {
  return JSON.stringify({ draftName, blocks });
}

export async function loadRoomSnapshot(roomConfig, fetchImpl = fetch) {
  const response = await fetchImpl(`${ROOM_API_PREFIX}${encodeURIComponent(roomConfig.roomId)}`, {
    method: "GET",
    headers: roomHeaders(roomConfig.key),
    cache: "no-store",
  });
  if (response.status === 404) return null;
  return roomJson(response);
}

export async function saveRoomSnapshot(roomConfig, draftName, blocks, fetchImpl = fetch) {
  const response = await fetchImpl(`${ROOM_API_PREFIX}${encodeURIComponent(roomConfig.roomId)}`, {
    method: "PUT",
    headers: roomHeaders(roomConfig.key, true),
    body: JSON.stringify({ draftName, blocks }),
  });
  return roomJson(response);
}
