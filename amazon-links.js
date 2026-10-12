// Localise Amazon links to the visitor's country. Used by the home page
// and the /books/ pages.
// Kindle e-book ASINs are the same across every Amazon
// marketplace, so we can safely swap only the domain and keep
// the product path. Placeholder buttons become a local search.
(function () {
  var DOMAINS = {
    US:'amazon.com', CA:'amazon.ca', GB:'amazon.co.uk', IE:'amazon.co.uk',
    AU:'amazon.com.au', NZ:'amazon.com.au', DE:'amazon.de', AT:'amazon.de',
    CH:'amazon.de', FR:'amazon.fr', IT:'amazon.it', ES:'amazon.es',
    NL:'amazon.nl', SE:'amazon.se', PL:'amazon.pl', JP:'amazon.co.jp',
    IN:'amazon.in', MX:'amazon.com.mx', BR:'amazon.com.br', SG:'amazon.sg',
    AE:'amazon.ae', SA:'amazon.sa', TR:'amazon.com.tr', EG:'amazon.eg'
  };

  function region() {
    try {
      var loc = (navigator.languages && navigator.languages[0]) || navigator.language || '';
      var m = loc.match(/[-_]([A-Za-z]{2})$/);
      if (m) return m[1].toUpperCase();
    } catch (e) {}
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      if (/Toronto|Vancouver|Edmonton|Winnipeg|Halifax|Montreal|Regina|St_Johns/.test(tz)) return 'CA';
      if (/London|Belfast|Dublin/.test(tz)) return 'GB';
      if (/Australia/.test(tz)) return 'AU';
      if (/Paris/.test(tz)) return 'FR';
      if (/Berlin|Zurich|Vienna/.test(tz)) return 'DE';
      if (/Madrid/.test(tz)) return 'ES';
      if (/Rome/.test(tz)) return 'IT';
      if (/Amsterdam/.test(tz)) return 'NL';
      if (/Tokyo/.test(tz)) return 'JP';
      if (/Kolkata|Calcutta/.test(tz)) return 'IN';
      if (/Mexico/.test(tz)) return 'MX';
      if (/Sao_Paulo/.test(tz)) return 'BR';
      if (/New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage/.test(tz)) return 'US';
    } catch (e) {}
    return 'US';
  }

  var domain = DOMAINS[region()] || 'amazon.com';

  Array.prototype.forEach.call(document.querySelectorAll('a[href]'), function (a) {
    var href = a.getAttribute('href');
    if (a.hasAttribute('data-amazon') && (href === '#' || !href)) {
      a.setAttribute('href', 'https://www.' + domain + '/s?k=' + encodeURIComponent(a.getAttribute('data-amazon')));
    } else if (/^https?:\/\/(www\.)?amazon\.[a-z.]+\//i.test(href)) {
      a.setAttribute('href', href.replace(/amazon\.[a-z.]+/i, domain));
    }
  });
})();
