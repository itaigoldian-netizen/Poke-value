// Poke Value auth: הרשמה/התחברות עם Google דרך Supabase Auth
// (בקשת בעלים 7/11 19:27: "חשבון שישמש למנויים ועוד דברים כמו שמירת קלפים במועדפים").
//
// AUTH_ENABLED הופעל (בעלים 7/11 19:51): Google OAuth client הוגדר בפרויקט
// GCP poke-value-514017 (מסך הסכמה פורסם ל-production), הספק Google פעיל
// ב-Supabase, והרשמה ציבורית מאושרת.
//
// מועדפים הם פיצ'ר מנוי (בעלים 7/11 19:28): window.PokeAuth.isSubscriber()
// בודק הרשאה פעילה בטבלת subscriptions; האכיפה האמיתית ברמת RLS בשרת,
// כאן רק חוויית המשתמש (הסתרת/הצגת הלב והודעת מנוי).
// חשבון הבעלים פטור מתשלום (בעלים 7/11 19:37) - גם כאן וגם במדיניות ה-RLS.
window.PV_AUTH_ENABLED = true;

window.PokeAuth = (function(){
  var SUPABASE_URL = 'https://yfxsvmujskqvtlnnfvog.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_9rKl0u1M4cndyvhN4wzA0A_zbsmtFch';
  var OWNER_ID = 'b362f086-9c13-45c6-b890-d222459275b9';
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
          subscriber = currentUser.id === OWNER_ID || !!(r && r.data);
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
  function isOwner(){ return !!currentUser && currentUser.id === OWNER_ID; }

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
           isSignedIn: isSignedIn, isSubscriber: isSubscriber, isOwner: isOwner,
           mountHeaderButton: mountHeaderButton, enabled: enabled,
           client: function(){ return client; } };
})();
