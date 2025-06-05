const http = require("http"),
  https = require("https"),
  fs = require("fs"),
  zlib = require("zlib"),
  querystring = require("querystring"),
  WebSocket = require("ws"),
  btoa = (str) => Buffer.from(str).toString("base64"),
  atob = (str) => Buffer.from(str, "base64").toString("utf-8");

module.exports = class {
  constructor(prefix = "/web/", config = {}) {
    this.prefix = prefix;
    this.config = config;
    this.cache = new Map(); // Simple in-memory cache

    this.proxifyRequestURL = (url, type) =>
      type
        ? atob(url.split("_").slice(1).splice(0, 1).join()) +
          url.split("_").slice(2).join("_")
        : `_${btoa(url.split("/").splice(0, 3).join("/"))}_/${url
            .split("/")
            .splice(3)
            .join("/")}`;

    if (!prefix.startsWith("/")) this.prefix = "/" + prefix;
    if (!prefix.endsWith("/")) this.prefix = prefix + "/";
  }

  http(req, res, next = () => res.end("")) {
    if (!req.url.startsWith(this.prefix)) return next();

    req.path = req.url.replace(this.prefix.slice(1), "");
    req.pathname = req.path.split("#")[0].split("?")[0];

    if (req.pathname == "/client_hook" || req.pathname == "/client_hook/")
      return res.end(fs.readFileSync(__dirname + "/window.js", "utf-8"));

    let targetUrl;
    try {
      targetUrl = new URL(this.proxifyRequestURL(req.path, true));
    } catch {
      return res.end("URL Parse Error");
    }

    const cacheKey = targetUrl.href + "|" + req.method;

    // Check cache for GET requests only
    if (req.method === "GET" && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      res.writeHead(cached.statusCode, cached.headers);
      return res.end(cached.body);
    }

    var proxyURL = {
        href: targetUrl.href,
        origin: targetUrl.origin,
        hostname: targetUrl.hostname,
      },
      proxify = {},
      isBlocked = false,
      protocol = proxyURL.href.startsWith("https://") ? https : http,
      proxyOptions = {
        headers: Object.assign({}, req.headers),
        method: req.method,
        rejectUnauthorized: false,
      };

    if (
      proxyURL.href.startsWith("https://") ||
      proxyURL.href.startsWith("http://")
    );
    else return res.end("URL Parse Error");

    delete proxyOptions.headers["host"];

    if (
      typeof this.config.blacklist == "object" &&
      this.config.blacklist.length != 0
    )
      this.config.blacklist.forEach((blacklisted) =>
        proxyURL.hostname == blacklisted ? (isBlocked = true) : false
      );
    if (isBlocked)
      return res.end(
        "The URL you are trying to access is not permitted for use."
      );

    if (!req.path.startsWith(`/_${btoa(proxyURL.origin)}_/`))
      return (
        res.writeHead(308, {
          location: this.prefix + `_${btoa(proxyURL.origin)}_/`,
        }),
        res.end("")
      );

    if (proxyOptions.headers["origin"]) {
      var proxified_header = this.proxifyRequestURL(
        `/${proxyOptions.headers["origin"]
          .split("/")
          .splice(3)
          .join("/")}`.replace(this.prefix, ""),
        true
      );
      if (
        proxified_header.startsWith("https://") ||
        proxified_header.startsWith("http://")
      )
        proxified_header = proxified_header.split("/").splice(0, 3).join("/");
      else proxified_header = proxyURL.origin;
      proxyOptions.headers["origin"] = proxified_header;
    }

    if (proxyOptions.headers["referer"]) {
      var proxified_header = this.proxifyRequestURL(
        "/" +
          proxyOptions.headers["referer"]
            .split("/")
            .splice(3)
            .join("/")
            .replace(this.prefix, ""),
        true
      );
      if (
        proxified_header.startsWith("https://") ||
        proxified_header.startsWith("http://")
      )
        proxified_header = proxified_header;
      else proxified_header = proxyURL.href;

      proxyOptions.headers["referer"] = proxified_header;
    }

    if (proxyOptions.headers["cookie"]) {
      var new_cookie = [],
        cookie_array = proxyOptions.headers["cookie"].split("; ");

      cookie_array.forEach((cookie) => {
        const cookie_name = cookie.split("=").splice(0, 1).join(),
          cookie_value = cookie.split("=").splice(1).join();

        if (proxyURL.hostname.includes(cookie_name.split("@").splice(1).join()))
          new_cookie.push(
            cookie_name.split("@").splice(0, 1).join() + "=" + cookie_value
          );
      });

      proxyOptions.headers["cookie"] = new_cookie.join("; ");
    }

    if (
      typeof this.config.localAddress == "object" &&
      this.config.localAddress.length != 0
    )
      proxyOptions.localAddress =
        this.config.localAddress[
          Math.floor(Math.random() * this.config.localAddress.length)
        ];

    var makeRequest = protocol.request(
      proxyURL.href,
      proxyOptions,
      (proxyResponse) => {
        var rawData = [],
          sendData = "";

        proxyResponse
          .on("data", (data) => rawData.push(data))
          .on("end", () => {
            const inject_config = {
              prefix: this.prefix,
              url: proxyURL.href,
            };

            proxify.url = (url) => {
              if (url.match(/^(#|about:|data:|blob:|mailto:|javascript:|{|\*)/))
                return url;

              if (url.startsWith("//")) url = new URL("http:" + url);
              else if (url.startsWith("/"))
                url = new URL(proxyURL.origin + url);
              else if (url.startsWith("https://") || url.startsWith("http://"))
                url = new URL(url);
              else
                url = new URL(
                  proxyURL.href.split("/").slice(0, -1).join("/") + "/" + url
                );

              if (url.protocol == "https:" || url.protocol == "http:")
                return this.prefix + this.proxifyRequestURL(url.href);
              else return url.href;
            };

            proxify.js = (buffer) =>
              buffer
                .toString()
                .replace(
                  /(,| |=|\()document.location(,| |=|\)|\.)/gi,
                  (str) => {
                    return str.replace(".location", `.alloyLocation`);
                  }
                )
                .replace(/(,| |=|\()window.location(,| |=|\)|\.)/gi, (str) => {
                  return str.replace(".location", `.alloyLocation`);
                })
                .replace(/(,| |=|\()location(,| |=|\)|\.)/gi, (str) => {
                  return str.replace("location", `alloyLocation`);
                });

            proxify.css = (buffer) => {
              return buffer
                .replace(/url\("(.*?)"\)/gi, (str) => {
                  var url = str.replace(/url\("(.*?)"\)/gi, "$1");
                  return `url("${proxify.url(url)}")`;
                })
                .replace(/url\('(.*?)'\)/gi, (str) => {
                  var url = str.replace(/url\('(.*?)'\)/gi, "$1");
                  return `url('${proxify.url(url)}')`;
                })
                .replace(/url\((.*?)\)/gi, (str) => {
                  var url = str.replace(/url\((.*?)\)/gi, "$1");

                  if (url.startsWith(`"`) || url.startsWith(`'`)) return str;

                  return `url("${proxify.url(url)}")`;
                })
                .replace(/@import (.*?)"(.*?)";/gi, (str) => {
                  var url = str.replace(/@import (.*?)"(.*?)";/, "$2");
                  return `@import "${proxify.url(url)}";`;
                })
                .replace(/@import (.*?)'(.*?)';/gi, (str) => {
                  var url = str.replace(/@import (.*?)'(.*?)';/, "$2");
                  return `@import '${proxify.url(url)}';`;
                });
            };

            proxify.html = (body) => {
              const html = new (require("./dom").JSDOM)(body, {
                  contentType: "text/html",
                }),
                document = html.window.document;

              var base_tag = false;

              if (document.querySelector("head base"))
                base_tag = document
                  .querySelector("head base")
                  .getAttribute("href");

              if (base_tag) {
                if (base_tag.includes("#") || base_tag.includes("?"))
                  base_tag = base_tag.split("#")[0].split("?")[0];

                if (base_tag.startsWith("//")) base_tag = "http:" + base_tag;

                if (
                  base_tag.startsWith("https://") ||
                  base_tag.startsWith("http://")
                )
                  base_tag = new URL(base_tag).href;
                else if (base_tag.startsWith("/"))
                  base_tag = new URL(proxyURL.origin + base_tag).href;
                else
                  base_tag = new URL(
                    proxyURL.href.split("/").slice(0, -1).join("/") +
                      "/" +
                      base_tag
                  ).href;

                inject_config.baseURL = base_tag;
              }

              proxify.attribute = (attribute) => {
                if (
                  attribute.startsWith("https://") ||
                  attribute.startsWith("http://") ||
                  attribute.startsWith("//")
                )
                  return proxify.url(attribute);
                else if (base_tag) {
                  if (attribute.startsWith("/"))
                    return (attribute = proxify.url(
                      base_tag.split("/").splice(0, 3).join("/") + attribute
                    ));
                  else
                    return (attribute = proxify.url(
                      base_tag.split("/").slice(0, -1).join("/") +
                        "/" +
                        attribute
                    ));
                } else return proxify.url(attribute);
              };

              document.querySelectorAll("*").forEach((node) => {
                if (node.getAttribute("nonce")) node.removeAttribute("nonce");
                if (node.getAttribute("integrity"))
                  node.removeAttribute("integrity");
                if (node.getAttribute("style"))
                  node.setAttribute(
                    "style",
                    proxify.css(node.getAttribute("style"))
                  );
              });

              document
                .querySelectorAll(
                  "script, embed, iframe, audio, video, img, input, source, track"
                )
                .forEach((node) => {
                  if (node.src) node.src = proxify.attribute(node.src);
                  if (
                    node.tagName.toLowerCase() == "script" &&
                    node.innerHTML != ""
                  )
                    node.innerHTML = proxify.js(node.innerHTML);
                });

              document
                .querySelectorAll("img[srcset], source[srcset]")
                .forEach((node) => {
                  var arr = [];

                  node.srcset.split(",").forEach((url) => {
                    url = url.trimStart().split(" ");
                    url[0] = proxify.attribute(url[0]);
                    arr.push(url.join(" "));
                  });

                  node.srcset = arr.join(", ");
                });

              document.querySelectorAll("a, link, area").forEach((node) => {
                if (node.href) node.href = proxify.attribute(node.href);
              });

              document
                .querySelectorAll(
                  'link[rel="stylesheet"], link[rel="stylesheet preload"], link[rel="stylesheet prefetch"]'
                )
                .forEach((node) => {
                  if (node.href) node.href = proxify.attribute(node.href);
                });

              document.querySelectorAll("style").forEach((node) => {
                if (node.innerHTML)
                  node.innerHTML = proxify.css(node.innerHTML);
              });

              document.querySelectorAll("form").forEach((node) => {
                if (node.action) node.action = proxify.attribute(node.action);
              });

              document
                .querySelectorAll("meta[http-equiv='refresh']")
                .forEach((node) => {
                  if (node.content) {
                    const match = node.content.match(/url=(.+)/i);
                    if (match && match[1])
                      node.content = `0; url=${proxify.attribute(match[1])}`;
                  }
                });

              const injectedScript = document.createElement("script");
              injectedScript.textContent = `
                window.alloyLocation = new Proxy(window.location, {
                  get: (target, prop) => {
                    if (prop === 'href') return "${proxyURL.href}";
                    return target[prop];
                  }
                });
              `;
              document.head.appendChild(injectedScript);

              return "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
            };

            if (
              proxyResponse.headers["content-encoding"] &&
              proxyResponse.headers["content-encoding"].includes("gzip")
            )
              zlib.gunzip(Buffer.concat(rawData), (err, decoded) => {
                if (err) {
                  res.writeHead(500);
                  return res.end("Decompression error");
                }

                sendData = proxify.html(decoded.toString());

                const compressed = zlib.gzipSync(sendData);
                const headers = Object.assign({}, proxyResponse.headers, {
                  "content-encoding": "gzip",
                  "content-length": Buffer.byteLength(compressed),
                });

                if (req.method === "GET") {
                  this.cache.set(cacheKey, {
                    statusCode: proxyResponse.statusCode,
                    headers,
                    body: compressed,
                  });
                }

                res.writeHead(proxyResponse.statusCode, headers);
                res.end(compressed);
              });
            else if (
              proxyResponse.headers["content-type"] &&
              proxyResponse.headers["content-type"].includes("text/html")
            ) {
              sendData = proxify.html(Buffer.concat(rawData).toString());

              const headers = Object.assign({}, proxyResponse.headers);
              headers["content-length"] = Buffer.byteLength(sendData);

              if (req.method === "GET") {
                this.cache.set(cacheKey, {
                  statusCode: proxyResponse.statusCode,
                  headers,
                  body: sendData,
                });
              }

              res.writeHead(proxyResponse.statusCode, headers);
              res.end(sendData);
            } else {
              const headers = Object.assign({}, proxyResponse.headers);

              if (req.method === "GET") {
                this.cache.set(cacheKey, {
                  statusCode: proxyResponse.statusCode,
                  headers,
                  body: Buffer.concat(rawData),
                });
              }

              res.writeHead(proxyResponse.statusCode, headers);
              res.end(Buffer.concat(rawData));
            }
          });
      }
    );

    req.pipe(makeRequest);

    makeRequest.on("error", () => {
      res.writeHead(504);
      res.end("Proxy request error");
    });
  }

  ws(req, socket, head) {
    if (!req || !req.url || !socket || !req.url.startsWith(this.prefix)) {
      if (socket && typeof socket.destroy === "function") {
        socket.destroy();
      }
      return;
    }

    const targetUrl = new URL(
      this.proxifyRequestURL(req.url.replace(this.prefix, ""), true)
    );
    const proxy = targetUrl.protocol === "wss:" ? https : http;

    const proxyWs = new WebSocket(targetUrl.href, {
      headers: req.headers,
      rejectUnauthorized: false,
    });

    proxyWs.on("open", () => {
      const ws = new WebSocket.Server({ noServer: true });
      ws.handleUpgrade(req, socket, head, (client) => {
        client.on("message", (msg) => proxyWs.send(msg));
        proxyWs.on("message", (msg) => client.send(msg));
        client.on("close", () => proxyWs.close());
        proxyWs.on("close", () => client.close());
      });
    });

    proxyWs.on("error", () => {
      if (socket && typeof socket.destroy === "function") {
        socket.destroy();
      }
    });
  }
};
