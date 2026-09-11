// The MVP has its own WebView profile; theme settings never read legacy data.
document.documentElement.setAttribute('data-theme', localStorage.getItem('hanni_theme') || 'light');
