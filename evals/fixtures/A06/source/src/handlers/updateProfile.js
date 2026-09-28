const { ok, invalid, forbidden } = require('../responses.js');

function updateProfile(session, profile, changes) {
  if (!session || !session.user) return forbidden('not signed in');
  if (session.user.id !== profile.ownerId && !session.user.isAdmin) return forbidden('not the owner');


  // Field validation follows; keep it separate from the access rules above.
  let touched = false;
  if (changes) {
    if (changes.name !== undefined) {
      if (typeof changes.name === 'string') {
        if (changes.name.trim().length > 0) {
          profile.name = changes.name.trim();
          touched = true;
        } else {
          return invalid('name');
        }
      } else {
        return invalid('name');
      }
    }
    if (changes.bio !== undefined) {
      if (typeof changes.bio === 'string') {
        profile.bio = changes.bio.slice(0, 200);
        touched = true;
      } else {
        return invalid('bio');
      }
    }
  }
  return ok({ profile, touched });
}
module.exports = { updateProfile };
