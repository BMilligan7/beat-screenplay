const ROOM_ID = /^[a-z0-9_-]{8,128}$/i;
const ROOM_KEY = /^[a-f0-9]{16,128}$/i;

function parameters(value, base) {
  try {
    const url = new URL(value, base);
    let fragment = url.hash.slice(1).replaceAll("&amp;", "&");
    // Some message clients percent-encode the entire fragment when copying a link.
    if (!fragment.includes("=") && /%3d/i.test(fragment)) fragment = decodeURIComponent(fragment);
    return new URLSearchParams(fragment);
  } catch { return new URLSearchParams(); }
}

export function parseRoomLink(value, base = "https://beat.invalid/") {
  const params = parameters(value, base);
  const roomId = params.get("room");
  const key = params.get("key");
  if (!ROOM_ID.test(roomId || "") || !ROOM_KEY.test(key || "")) return null;
  return { roomId, key, seed: params.get("seed") || "", joined: true };
}

export function hasRoomLinkParameters(value, base = "https://beat.invalid/") {
  const params = parameters(value, base);
  if (params.has("room") || params.has("key")) return true;
  try { return /(?:^#|&|%26)(?:room|key)(?:=|%3d)/i.test(new URL(value, base).hash); }
  catch { return false; }
}

export function buildRoomLink(base, room) {
  const url = new URL(base);
  url.hash = new URLSearchParams({ room: room.roomId, key: room.key }).toString();
  return url.href;
}

export function resolveRoomLink(value, savedRoom) {
  const explicit = parseRoomLink(value);
  if (explicit || hasRoomLinkParameters(value)) return explicit;
  // An incomplete link must not silently open a different previously used room.
  if (!savedRoom) return null;
  return parseRoomLink(buildRoomLink(value, savedRoom));
}
