package tokenmint

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLoopbackOnly_RefusesWebPages(t *testing.T) {
	reached := false
	handler := LoopbackOnly(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}))
	for _, origin := range []string{"https://attacker.example", "null", "http://127.0.0.1:3000"} {
		t.Run(origin, func(t *testing.T) {
			// A simple form POST: no preflight, so the browser sends it as is.
			req := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader(`{"name": "x"}`))
			req.Host = "127.0.0.1:8787"
			req.Header.Set("Content-Type", "text/plain")
			req.Header.Set("Origin", origin)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			require.Equal(t, http.StatusForbidden, rec.Code)
		})
	}
	require.False(t, reached)
}

func TestLoopbackOnly(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := LoopbackOnly(next)
	for host, want := range map[string]int{
		"127.0.0.1:8787":         http.StatusOK,
		"localhost:8787":         http.StatusOK,
		"[::1]:8787":             http.StatusOK,
		"127.0.0.1":              http.StatusOK,
		"attacker.example:8787":  http.StatusForbidden,
		"192.168.1.20:8787":      http.StatusForbidden,
		"localhost.example:8787": http.StatusForbidden,
		"":                       http.StatusForbidden,
	} {
		t.Run(host, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/health", nil)
			req.Host = host
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			require.Equal(t, want, rec.Code)
		})
	}
}
