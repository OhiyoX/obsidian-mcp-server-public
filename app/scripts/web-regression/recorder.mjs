// check() registration, pass/fail recording and the shared sleep helper.
export const results=[];
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function check(name, fn) {
  if(process.env.WEB_TEST_ONLY && !new RegExp(process.env.WEB_TEST_ONLY).test(name))return;
  const start=Date.now();
  try {await fn();results.push({name,pass:true,ms:Date.now()-start});console.log(`PASS ${name}`);}
  catch(error){results.push({name,pass:false,error:error.message,ms:Date.now()-start});console.log(`FAIL ${name}: ${error.message}`);}
}
