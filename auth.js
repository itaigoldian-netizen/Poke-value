// Poke Value auth: הרשמה/התחברות עם Google דרך Supabase Auth
// (בקשת בעלים 7/11 19:27: "חשבון שישמש למנויים ועוד דברים כמו שמירת קלפים במועדפים").
//
// AUTH_ENABLED נשאר false עד שהבעלים מאשר ומושלמת ההגדרה (Google OAuth client
// בחשבון ה-Google של הבעלים + הפעלת הספק ב-Supabase) - הקוד נשלח רדום ואין
// הרשמה ציבורית בפועל לפני כן.
//
// מועדפים הם פיצ'ר מנוי (בעלים 7/11 19:28): window.PokeAuth.isSubscriber()
// בודק הרשאה פעילה בטבלת subscriptions; האכיפה האמיתית ברמת RLS בשרת,
// כאן רק חוויית המשתמש (הסתרת/הצגת הלב והודעת מנוי).
window.PV_AUTH_ENABLED = false;

window.PokeAuth = (function(){
  var SUPABASE_URL = 'https://yfxsvmujskqvtlnnfvog.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_9rKl0u1M4cndyvhN4wzA0A_zbsmtFch';
  var client = null;
  var currentUser = null;
  var subscriber = null; // null = unknown, false = guest/no entitlement, true = active

  function enabled(){ return window.PV_AUTH_ENABLED === true; }

  function ready(){
    if (!enabled() || !window.supabase) return Promise.resolve(null);
    if (!client) client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return client.auth.getSession().then(function(res){
      currentUser = res && res.data && res.data.session ? res.data.session.user : null;
      if (!currentUser){ subscriber = false; return null; }
      return client.from('subscriptions').select('user_id').eq('user_id', currentUser.id).eq('status', 'active').maybeSingle()
        .then(function(r){
          subscriber = !!(r && r.data);
          return currentUser;
        });
    });
  }

  function signIn(){
    if (!enabled() || !client) return Promise.resolve();
    return client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname }
    });
  }

  function signOut(){
    if (!enabled() || !client) return Promise.resolve();
    return client.auth.signOut().then(function(){
      currentUser = null; subscriber = false; location.reload();
    });
  }

  function user(){ return currentUser; }
  function isSubscriber(){ return subscriber === true; }
  function isSignedIn(){ return !!currentUser; }

  // כפתור התחברות/התנתקות קטן ב-header. נקרא מהדפים אחרי ready().
  function mountHeaderButton(container){
    if (!enabled() || !container) return;
    var btn = document.createElement('button');
    btn.className = 'pv-auth-btn';
    function paint(){
      btn.textContent = isSignedIn() ? 'התנתקות' : 'התחברות עם Google';
    }
    btn.addEventListener('click', function(){
      if (isSignedIn()) signOut(); else signIn();
    });
    paint();
    container.appendChild(btn);
  }

  return { ready: ready, signIn: signIn, signOut: signOut, user: user,
           isSignedIn: isSignedIn, isSubscriber: isSubscriber,
           mountHeaderButton: mountHeaderButton, enabled: enabled,
           client: function(){ return client; } };
})();
