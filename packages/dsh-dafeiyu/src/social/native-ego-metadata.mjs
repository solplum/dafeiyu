import { nativeEgoEnvelope } from './native-ego-script.mjs';

// Read native bookkeeping only: no platform navigation, DOM, login or adoption.
export function nativeEgoMetadataScript(binding, marker, profileId) {
  return nativeEgoEnvelope(`
const binding=${JSON.stringify(binding)},profileId=${JSON.stringify(profileId)};
const found=(await listTaskSpaces()).find(row=>row.id===binding.spaceId);
if(!found)return {ready:false,reason:'space-unavailable'};
if(found.name!==binding.spaceName||found.ownership!=='agent'||profileId!==undefined&&found.profileId!==profileId)return {ready:false,reason:'ownership-changed'};
const task=await taskSpace(binding.spaceId);
if(task.spaceId!==binding.spaceId||task.name!==binding.spaceName||task.ownership!=='agent')return {ready:false,reason:'ownership-changed'};
const tabs=await task.tabs();
if(tabs.filter(row=>row.label===binding.pageLabel&&row.openedBy==='agent').length!==1)return {ready:false,reason:'identity-page-unavailable'};
return {ready:true};`, marker);
}

// A completed activity normally has no Space. Explicit readiness checks read
// only the fixed owner-selected profile; they never allocate a replacement.
export function nativeEgoProfileMetadataScript(profileId, marker) {
  return nativeEgoEnvelope(`
const found=(await profiles()).filter(row=>row.id===${JSON.stringify(profileId)});
return found.length===1?{ready:true}:{ready:false,reason:'profile-unavailable'};`,marker);
}
