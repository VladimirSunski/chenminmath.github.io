const navToggle = document.querySelector('.nav-toggle');
const nav = document.querySelector('.site-nav');

if (navToggle && nav) {
  navToggle.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(isOpen));
  });
}

const path = window.location.pathname;
const navLinks = document.querySelectorAll('[data-nav]');

navLinks.forEach((link) => {
  const section = link.getAttribute('data-nav');
  const href = link.getAttribute('href');

  const matchers = {
    home: /(?:\/|index\.html)$/,
    research: /research\.html$/,
    teaching: /teaching\.html$/,
    blog: /\/blog\/(?:index\.html|welcome\.html)?$/
  };

  if (matchers[section] && matchers[section].test(path)) {
    link.classList.add('active');
  }

  if (!path || path.endsWith('/')) {
    if (section === 'home' && (href === 'index.html' || href === '../index.html')) {
      link.classList.add('active');
    }
  }
});
