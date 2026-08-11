// Router HTTP minimalista, sem dependências externas (Express não pôde ser instalado
// neste ambiente por falta de acesso à rede — ver relatório final). API compatível o
// suficiente para trocar por Express depois sem reescrever as rotas de negócio.
class Router {
  constructor() {
    this.routes = []; // {method, pattern: RegExp, paramNames, handler}
  }

  _add(method, path, handler) {
    const paramNames = [];
    const pattern = new RegExp(
      '^' +
        path
          .replace(/\/:([A-Za-z0-9_]+)/g, (_, name) => {
            paramNames.push(name);
            return '/([^/]+)';
          })
          .replace(/\//g, '\\/') +
        '$'
    );
    this.routes.push({ method, pattern, paramNames, handler });
  }

  get(path, handler) { this._add('GET', path, handler); }
  post(path, handler) { this._add('POST', path, handler); }
  put(path, handler) { this._add('PUT', path, handler); }
  delete(path, handler) { this._add('DELETE', path, handler); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = pathname.match(route.pattern);
      if (!m) continue;
      const params = {};
      route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      return { handler: route.handler, params };
    }
    return null;
  }
}

module.exports = Router;
