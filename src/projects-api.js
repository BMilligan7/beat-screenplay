import { getDeviceItem, setDeviceItem } from "./device-storage.js";

export async function projectRequest(path = "", {method="GET",body,key,fetchImpl=fetch}={}) {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetchImpl(`/api/projects${path}`,{method,cache:"no-store",signal:controller.signal,headers:{...(body?{"content-type":"application/json"}:{}),...(key?{authorization:`Bearer ${key}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok){const error=new Error(data.error||"The project library could not connect.");error.status=response.status;throw error;}return data;
  }catch(error){if(error.name==="AbortError")throw new Error("The project library took too long to respond. Try again.");throw error;}finally{clearTimeout(timer);}
}
function token(bytes=16){return Array.from(crypto.getRandomValues(new Uint8Array(bytes)),v=>v.toString(16).padStart(2,"0")).join("");}
export async function createProject(name) {
  const title=name.trim();if(!title)throw new Error("Enter a project title.");
  let pending;try{pending=JSON.parse(getDeviceItem("beat-pending-project-v1")||"null");}catch{/* Ignore malformed local retry data. */}
  if(pending && pending.name!==title)throw new Error(`Finish creating “${pending.name}” before starting another project.`);
  const body=pending||{name:title,roomId:token(10),key:token(24)};
  if(!setDeviceItem("beat-pending-project-v1",JSON.stringify(body)))throw new Error("Allow browser storage before creating a project so its link can be recovered if the connection drops.");
  try{const data=await projectRequest("",{method:"POST",body});setDeviceItem("beat-pending-project-v1","");return data.project;}
  catch(error){if(error.status>=400 && error.status<500)setDeviceItem("beat-pending-project-v1","");throw error;}
}
