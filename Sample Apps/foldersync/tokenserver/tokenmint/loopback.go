package tokenmint

import (
	"net"
	"net/http"
	"strings"
)

// LoopbackOnly answers only requests addressed to this computer, and none
// from a web page. A page that points its own hostname at 127.0.0.1 (DNS
// rebinding) still sends that hostname in Host. A page on any site can POST to
// 127.0.0.1 directly, but browsers send Origin on those requests, while the
// app and curl don't.
func LoopbackOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !IsLoopbackHost(r.Host) {
			writeJSON(w, http.StatusForbidden, errorBody{Error: "the token server only answers requests to localhost"})
			return
		}
		if r.Header.Get("Origin") != "" {
			writeJSON(w, http.StatusForbidden, errorBody{Error: "the token server doesn't answer web pages"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// IsLoopbackHost reports whether host, with or without a port, is localhost or
// a loopback IP address.
func IsLoopbackHost(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
