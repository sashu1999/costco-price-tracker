// Supabase project for accounts. Both values are public by design (they ship in the page);
// the database only lets a signed-in, two-step-verified user see their own rows.
// Leave them empty to run without accounts (items stay in this browser).
window.APP_CONFIG = {
  supabaseUrl: "",
  supabaseKey: "",
};
