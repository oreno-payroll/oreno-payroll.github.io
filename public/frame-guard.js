/* Best-effort frame refusal for GitHub Pages. Not a substitute for HTTP CSP frame-ancestors. */
(function(){
  if(window.self===window.top)return;
  document.documentElement.style.display='none';
  document.documentElement.setAttribute('data-payroll-framed','blocked');
  window.stop();
}());
