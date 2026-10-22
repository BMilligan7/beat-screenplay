// All scripts, names, room identifiers, and keys below are fictional test fixtures.
import assert from 'node:assert/strict';
import test from 'node:test';
import {parseRoomLink,hasRoomLinkParameters,buildRoomLink,resolveRoomLink} from '../src/room-link.js';

const room={roomId:'shared-test-room',key:'0123456789abcdef0123456789abcdef'};
const origin='https://beat.example/';

test('the existing complete collaboration link opens the same room',()=>{
  assert.deepEqual(parseRoomLink(buildRoomLink(origin,room)),{...room,seed:'',joined:true});
});
test('accepts a link copied with an HTML escaped separator or encoded fragment',()=>{
  const link=buildRoomLink(origin,room);
  assert.equal(parseRoomLink(link.replace('&key=','&amp;key=')).key,room.key);
  assert.equal(parseRoomLink(origin+'#'+encodeURIComponent(link.split('#')[1])).roomId,room.roomId);
});
test('a bare site resumes the last room saved on this device',()=>{
  assert.equal(resolveRoomLink(origin,room).roomId,room.roomId);
  assert.equal(resolveRoomLink(origin,null),null);
});
test('incomplete and invalid room links never open the demo or a different recent room',()=>{
  for(const hash of ['#room=shared-test-room','#key='+room.key,'#room=x&key=bad']){
    assert.equal(hasRoomLinkParameters(origin+hash),true);
    assert.equal(resolveRoomLink(origin+hash,room),null);
  }
});
test('an explicit valid room always takes priority over the saved room',()=>{
  const different={...room,roomId:'another-shared-room'};
  assert.equal(resolveRoomLink(buildRoomLink(origin,different),room).roomId,different.roomId);
});

test('a damaged encoded room link does not fall back to another script',()=>{
  const damaged=origin+'#room%3Dshared-test-room%26key%3D0123456789abcdef%ZZ';
  assert.equal(hasRoomLinkParameters(damaged),true);
  assert.equal(resolveRoomLink(damaged,room),null);
});
