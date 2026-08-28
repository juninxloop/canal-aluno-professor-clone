// ============================================================
// CONFIGURAÇÃO DO SUPABASE
// ============================================================
// Troque os valores abaixo pelos do SEU projeto.
// Onde encontrar: painel do Supabase > Project Settings > API
//   - "Project URL"      -> SUPABASE_URL
//   - "anon public" key  -> SUPABASE_ANON_KEY
//
// A "anon key" é segura para ficar no front-end: ela só permite
// o que as regras de RLS (Row Level Security) autorizarem no banco.
// ============================================================

const SUPABASE_URL = "https://ycsfglnaaekzfzrzjngc.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inljc2ZnbG5hYWVremZ6cnpqbmdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3MjQwMzAsImV4cCI6MjEwMzMwMDAzMH0.SmXteeoIsVxB-AewAIC2ijU8GnVoyRjJQ4n8Ud097jQ";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
