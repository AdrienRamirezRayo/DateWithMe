function authForm(endpoint) {
  const form = document.getElementById('form');
  const err = document.getElementById('err');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    err.textContent = '';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error);
      location.href = '/dashboard';
    } catch (e2) {
      err.textContent = e2.message || 'Something went wrong.';
      btn.disabled = false;
    }
  });
}
