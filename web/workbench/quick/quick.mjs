const query = new URLSearchParams(location.search);
if (!query.has('conversation') || query.has('batch') || query.has('clients')) query.set('area','quick');
location.replace('/workbench/zip/index.html' + (query.size ? `?${query}` : ''));
