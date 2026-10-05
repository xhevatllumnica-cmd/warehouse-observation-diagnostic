/* Runs on WMS pages only: reads the name of the logged-in account from the page header ("user-wrapper") and hands it to
   the extension. On the login page the name is empty (= nobody logged in). Nothing else on the page is read. */
(function(){
  function report(){
    const el=document.querySelector('.user-wrapper b');
    const loginPage=!!document.querySelector('input[name="Password"], #loginForm');
    const user= el? el.textContent.replace(/\s+/g,' ').trim() : '';
    if(el || loginPage) chrome.runtime.sendMessage({type:'wmsUser', user: loginPage? '' : user});
  }
  report();
  document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='visible') report(); });
})();
