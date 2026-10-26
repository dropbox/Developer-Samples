package tokenmint

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

var fixedNow = time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

// fakeDropbox serves one route and records the last request.
type fakeDropbox struct {
	route    string
	status   int
	response string
	lastBody []byte
	lastUser string
	lastPass string
}

func (f *fakeDropbox) start(t *testing.T) *httptest.Server {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The handler runs on the server's goroutine, so it can't call require.
		if r.URL.Path != f.route {
			t.Errorf("path = %q, want %q", r.URL.Path, f.route)
		}
		f.lastUser, f.lastPass, _ = r.BasicAuth()
		var err error
		if f.lastBody, err = io.ReadAll(r.Body); err != nil {
			t.Errorf("read request: %v", err)
		}
		w.WriteHeader(f.status)
		if _, err := w.Write([]byte(f.response)); err != nil {
			t.Errorf("write response: %v", err)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func newClient(endpoint string) *AppClient {
	return &AppClient{
		Client:    http.DefaultClient,
		Endpoint:  endpoint,
		AppKey:    "key",
		AppSecret: "secret",
		Scopes:    UserScopes,
		Now:       func() time.Time { return fixedNow },
	}
}

func TestMint_ReturnsTokenAndExpiry(t *testing.T) {
	fake := &fakeDropbox{route: mintRoute, status: http.StatusOK, response: `{"access_token": "tok", "expires_in": 14400}`}
	server := fake.start(t)

	tok, err := newClient(server.URL).Mint(t.Context(), "user-1")

	require.NoError(t, err)
	require.Equal(t, Token{AccessToken: "tok", ExpiresAt: fixedNow.Add(4 * time.Hour)}, tok)
	require.JSONEq(t, `{
		"user": {".tag": "user_public_id", "user_public_id": "user-1"},
		"scopes": [
			"files.metadata.read",
			"files.metadata.write",
			"files.content.read",
			"files.content.write",
			"private:agent_filesystem.agents.manage",
			"private:agent_filesystem.agents.restore"
		]
	}`, string(fake.lastBody))
	require.Equal(t, "key", fake.lastUser)
	require.Equal(t, "secret", fake.lastPass)
}

func TestMint_ReportsDropboxErrorSummary(t *testing.T) {
	fake := &fakeDropbox{route: mintRoute, status: http.StatusForbidden, response: `{"error_summary": "no_permission/..."}`}
	server := fake.start(t)

	_, err := newClient(server.URL).Mint(t.Context(), "user-1")

	var apiErr *APIError
	require.ErrorAs(t, err, &apiErr)
	require.Equal(t, &APIError{Status: http.StatusForbidden, Summary: "no_permission/..."}, apiErr)
}

func TestMint_RejectsResponseWithoutAValidExpiry(t *testing.T) {
	for name, response := range map[string]string{
		"no expiry":   `{"access_token": "tok"}`,
		"overflowing": `{"access_token": "tok", "expires_in": 9223372036854775807}`,
	} {
		t.Run(name, func(t *testing.T) {
			fake := &fakeDropbox{route: mintRoute, status: http.StatusOK, response: response}
			server := fake.start(t)

			_, err := newClient(server.URL).Mint(t.Context(), "user-1")

			require.ErrorContains(t, err, "no token or valid expiry")
		})
	}
}

func TestMint_RejectsAResponseOverTheSizeLimit(t *testing.T) {
	big := `{"access_token": "tok", "expires_in": 14400}` + strings.Repeat(" ", maxResponseBytes)
	fake := &fakeDropbox{route: mintRoute, status: http.StatusOK, response: big}
	server := fake.start(t)

	_, err := newClient(server.URL).Mint(t.Context(), "user-1")

	require.ErrorContains(t, err, "larger than")
}

func TestMint_RejectsEmptyUser(t *testing.T) {
	_, err := newClient("http://unused").Mint(t.Context(), "")

	require.ErrorContains(t, err, "user public ID is empty")
}

func TestCheckCredentials(t *testing.T) {
	fake := &fakeDropbox{route: checkAppRoute, status: http.StatusOK, response: `{"result": "foldersync"}`}
	server := fake.start(t)
	require.NoError(t, newClient(server.URL).CheckCredentials(t.Context()))

	bad := &fakeDropbox{route: checkAppRoute, status: http.StatusUnauthorized, response: `{"error_summary": "invalid_client"}`}
	badServer := bad.start(t)
	require.ErrorContains(t, newClient(badServer.URL).CheckCredentials(t.Context()), "invalid_client")
}

func TestDeleteUser_SendsTheUserSelector(t *testing.T) {
	fake := &fakeDropbox{route: deleteUserRoute, status: http.StatusOK, response: `null`}
	server := fake.start(t)

	err := newClient(server.URL).DeleteUser(t.Context(), "pid_user:abc")

	require.NoError(t, err)
	require.JSONEq(t, `{"users": [{".tag": "user_public_id", "user_public_id": "pid_user:abc"}]}`, string(fake.lastBody))
}

func TestCreateUser_ReturnsThePublicID(t *testing.T) {
	fake := &fakeDropbox{route: createUserRoute, status: http.StatusOK, response: `{"users": [{"user_public_id": "pid_user:abc", "name": "demo"}]}`}
	server := fake.start(t)

	id, err := newClient(server.URL).CreateUser(t.Context(), "demo")

	require.NoError(t, err)
	require.Equal(t, "pid_user:abc", id)
	require.JSONEq(t, `{"entries": [{"name": "demo"}]}`, string(fake.lastBody))
	require.Equal(t, "key", fake.lastUser)
}
