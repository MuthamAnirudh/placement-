/* CPU-isolated helper for existing portal infrastructure. */
self.onmessage=async(e)=>{
  const {id,type,payload}=e.data||{};
  try{
    if(type==='sha256'){
      const bytes=new TextEncoder().encode(String(payload));
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      const value=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
      self.postMessage({id,ok:true,value});return;
    }
    throw new Error('unsupported operation');
  }catch(err){self.postMessage({id,ok:false,error:String(err?.message||err)})}
};
