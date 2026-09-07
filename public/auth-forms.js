'use strict';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let mode = params.get('mode') === 'signup' ? 'signup' : 'login';
const next = params.get('next') || '/app.html';

function applyMode() {
  const signup = mode === 'signup';
  $('authTitle').textContent = signup ? 'Create your account' : 'Welcome back';
  $('authSub').textContent = signup ? 'Start free in seconds' : 'Login to your dashboard';
  $('nameFld').style.display = signup ? '' : 'none';
  $('submitBtn').textContent = signup ? 'Sign up' : 'Login';
  $('switchText').textContent = signup ? 'Already have an account?' : 'New here?';
  $('switchLink').textContent = signup ? 'Login' : 'Create an account';
  $('password').autocomplete = signup ? 'new-password' : 'current-password';
}
applyMode();

$('switchLink').addEventListener('click', (e) => {
  e.preventDefault();
  mode = mode === 'signup' ? 'login' : 'signup';
  applyMode();
  msg('', true);
});

function msg(t, ok) { const m = $('authMsg'); m.textContent = t; m.style.color = ok ? 'var(--up)' : 'var(--down)'; }

async function submit() {
  const body = {
    name: $('name').value.trim(),
    email: $('email').value.trim(),
    password: $('password').value,
  };
  if (!body.email || !body.password) { msg('Email aur password daalo', false); return; }
  msg('Please wait…', true);
  try {
    const url = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    const r = await fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.ok) { msg('✅ Success! Redirecting…', true); location.href = next; }
    else msg('❌ ' + (j.error || 'Failed'), false);
  } catch (e) { msg('❌ ' + e.message, false); }
}

$('submitBtn').addEventListener('click', submit);
['email', 'password', 'name'].forEach((id) =>
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); })
);
