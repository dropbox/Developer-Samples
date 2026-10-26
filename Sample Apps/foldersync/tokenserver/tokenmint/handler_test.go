package tokenmint

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"errors"
)

// fakeAPI stands in for the Dropbox managed-user routes.
type fakeAPI struct {
	mintErr   error
	deleteErr error
	created   []string
	deleted   []string
	minted    []string
	// onCreate and onDelete run inside CreateUser and DeleteUser.
	onCreate func()
	onDelete func()
	// createID, if set, is the user public ID CreateUser returns.
	createID string
}

func (f *fakeAPI) Mint(_ context.Context, userPublicID string) (Token, error) {
	f.minted = append(f.minted, userPublicID)
	if f.mintErr != nil {
		return Token{}, f.mintErr
	}
	return Token{AccessToken: "tok-" + userPublicID, ExpiresAt: fixedNow}, nil
}

// CreateUser fails if ctx is done after onCreate, like a real call whose
// response is never read.
func (f *fakeAPI) CreateUser(ctx context.Context, name string) (string, error) {
	f.created = append(f.created, name)
	if f.onCreate != nil {
		f.onCreate()
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if f.createID != "" {
		return f.createID, nil
	}
	return "pid_user:" + name, nil
}

// DeleteUser fails if ctx is done after onDelete, like CreateUser.
func (f *fakeAPI) DeleteUser(ctx context.Context, userPublicID string) error {
	if f.onDelete != nil {
		f.onDelete()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.deleted = append(f.deleted, userPublicID)
	return nil
}

func newHandler(t *testing.T, api Dropbox) *Handler {
	return &Handler{
		Dropbox:   api,
		UsersPath: filepath.Join(t.TempDir(), "tokenserver", "users.json"),
		AppKey:    "app-key",
		Now:       func() time.Time { return fixedNow },
	}
}

func call(t *testing.T, h *Handler, method, path, key, body string) (int, map[string]any) {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return rec.Code, out
}

func login(t *testing.T, h *Handler, name string) LoginResult {
	req := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader(`{"name": "`+name+`"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var res LoginResult
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
	return res
}

func TestLogin_CreatesTheUserOnceThenReturnsTheSameOne(t *testing.T) {
	api := &fakeAPI{}
	h := newHandler(t, api)

	first := login(t, h, "demo")
	again := login(t, h, "demo")

	require.True(t, first.Created)
	require.False(t, again.Created)
	require.Equal(t, "pid_user:demo", first.UserPublicID)
	require.Equal(t, first.UserPublicID, again.UserPublicID)
	require.Equal(t, first.ConnectionKey, again.ConnectionKey)
	require.Equal(t, []string{"demo"}, api.created)
}

func TestLogin_RejectsBadNames(t *testing.T) {
	api := &fakeAPI{}
	h := newHandler(t, api)

	for _, body := range []string{`{"name": ""}`, `{"name": "a/b"}`, `not json`} {
		code, _ := call(t, h, http.MethodPost, "/login", "", body)
		require.Equal(t, http.StatusBadRequest, code, body)
	}
	require.Empty(t, api.created)
}

func TestToken_MintsOnlyForTheConnectionKeysUser(t *testing.T) {
	h := newHandler(t, &fakeAPI{})
	alice := login(t, h, "alice")
	bob := login(t, h, "bob")

	code, body := call(t, h, http.MethodPost, "/token", alice.ConnectionKey, "")
	require.Equal(t, http.StatusOK, code)
	require.Equal(t, "tok-pid_user:alice", body["access_token"])
	require.Equal(t, fixedNow.Format(time.RFC3339), body["expires_at"])

	_, body = call(t, h, http.MethodPost, "/token", bob.ConnectionKey, "")
	require.Equal(t, "tok-pid_user:bob", body["access_token"])
}

func TestToken_RejectsUnknownOrMissingConnectionKey(t *testing.T) {
	api := &fakeAPI{}
	h := newHandler(t, api)
	login(t, h, "demo")

	for _, key := range []string{"", "not-a-key"} {
		code, body := call(t, h, http.MethodPost, "/token", key, "")
		require.Equal(t, http.StatusUnauthorized, code, key)
		require.Equal(t, "unknown connection key", body["error"], key)
	}
	require.Empty(t, api.minted)
}

func TestToken_PassesDropboxErrorsBackAndHidesOthers(t *testing.T) {
	api := &fakeAPI{mintErr: fmt.Errorf("mint token: %w", &APIError{Status: http.StatusForbidden, Summary: "no_permission/"})}
	h := newHandler(t, api)
	key := login(t, h, "demo").ConnectionKey

	code, body := call(t, h, http.MethodPost, "/token", key, "")
	require.Equal(t, http.StatusBadGateway, code)
	require.Equal(t, "no_permission/", body["error"])

	api.mintErr = errors.New("dial tcp: secret detail")
	_, body = call(t, h, http.MethodPost, "/token", key, "")
	require.Equal(t, "mint failed", body["error"])
}

func TestDeleteAccount_DeletesInDropboxThenForgetsTheUser(t *testing.T) {
	api := &fakeAPI{}
	h := newHandler(t, api)
	demo := login(t, h, "demo")

	code, body := call(t, h, http.MethodPost, "/delete-account", demo.ConnectionKey, "")

	require.Equal(t, http.StatusOK, code)
	require.Equal(t, "demo", body["deleted"])
	require.Equal(t, []string{"pid_user:demo"}, api.deleted)
	code, _ = call(t, h, http.MethodPost, "/token", demo.ConnectionKey, "")
	require.Equal(t, http.StatusUnauthorized, code)
}

func TestDeleteAccount_KeepsTheUserWhenDropboxFails(t *testing.T) {
	api := &fakeAPI{deleteErr: &APIError{Status: http.StatusInternalServerError, Summary: "internal_error"}}
	h := newHandler(t, api)
	key := login(t, h, "demo").ConnectionKey

	code, _ := call(t, h, http.MethodPost, "/delete-account", key, "")
	require.Equal(t, http.StatusBadGateway, code)

	code, _ = call(t, h, http.MethodPost, "/token", key, "")
	require.Equal(t, http.StatusOK, code)
}

func TestDeleteAccount_ReportsAUsersFileSaveFailureAfterDeleting(t *testing.T) {
	api := &fakeAPI{}
	h := newHandler(t, api)
	key := login(t, h, "demo").ConnectionKey
	// Dropbox deletes the account, then saving users.json fails.
	api.onDelete = func() {
		writeUsersFile = func(context.Context, string, []byte) error { return errors.New("disk full") }
	}
	t.Cleanup(func() { writeUsersFile = writeFileAtomic })

	code, body := call(t, h, http.MethodPost, "/delete-account", key, "")

	require.Equal(t, http.StatusInternalServerError, code)
	require.Contains(t, body["error"], "the account was deleted")
	require.Equal(t, []string{"pid_user:demo"}, api.deleted)
	users, err := LoadUsers(t.Context(), h.UsersPath)
	require.NoError(t, err)
	_, ok := users.Find("demo")
	require.True(t, ok, "the local record stays, so the removal can be retried")
}

func TestLogin_RejectsBodiesThatArentOneKnownObject(t *testing.T) {
	api := &fakeAPI{}
	h := newHandler(t, api)
	for name, body := range map[string]string{
		"trailing data": `{"name": "demo"} {"name": "other"}`,
		"unknown field": `{"name": "demo", "admin": true}`,
		// A valid name, padded past the body limit.
		"too large": `{"name": "demo"` + strings.Repeat(" ", maxBodyBytes) + `}`,
		"not JSON":  `name=demo`,
	} {
		t.Run(name, func(t *testing.T) {
			code, _ := call(t, h, http.MethodPost, "/login", "", body)
			require.Equal(t, http.StatusBadRequest, code)
		})
	}
	require.Empty(t, api.created, "no managed user is created")
}

func TestLogin_DeletesTheNewManagedUserWhenSavingFails(t *testing.T) {
	api := &fakeAPI{}
	h := newHandler(t, api)
	// Saving users.json fails after users/create succeeds.
	api.onCreate = func() {
		writeUsersFile = func(context.Context, string, []byte) error { return errors.New("disk full") }
	}
	t.Cleanup(func() { writeUsersFile = writeFileAtomic })
	req := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader(`{"name": "demo"}`))
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	require.Equal(t, http.StatusBadGateway, rec.Code)
	require.Equal(t, []string{"demo"}, api.created)
	require.Equal(t, []string{"pid_user:demo"}, api.deleted)
	users, err := LoadUsers(t.Context(), h.UsersPath)
	require.NoError(t, err)
	require.Empty(t, users.Users)
}

func TestDeleteAccount_KeepsAUserThatTookTheNameMeanwhile(t *testing.T) {
	api := &fakeAPI{}
	h := newHandler(t, api)
	old := login(t, h, "demo")
	var replacement User
	// While Dropbox deletes the old user, someone removes it and signs in again as "demo".
	api.onDelete = func() {
		require.NoError(t, UpdateUsers(t.Context(), h.UsersPath, func(f *UsersFile) error {
			f.RemoveByKey(old.ConnectionKey)
			var err error
			replacement, err = f.Add("demo", "pid_user:demo-2", fixedNow)
			return err
		}))
	}

	code, _ := call(t, h, http.MethodPost, "/delete-account", old.ConnectionKey, "")

	require.Equal(t, http.StatusOK, code)
	users, err := LoadUsers(t.Context(), h.UsersPath)
	require.NoError(t, err)
	require.Equal(t, []User{replacement}, users.Users)
}

func TestDeleteAccount_ForgetsTheUserEvenIfTheRequestIsCanceled(t *testing.T) {
	api := &fakeAPI{}
	h := newHandler(t, api)
	demo := login(t, h, "demo")
	ctx, cancel := context.WithCancel(context.Background())
	api.onDelete = cancel

	req := httptest.NewRequest(http.MethodPost, "/delete-account", nil).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+demo.ConnectionKey)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Equal(t, []string{"pid_user:demo"}, api.deleted)
	code, _ := call(t, h, http.MethodPost, "/token", demo.ConnectionKey, "")
	require.Equal(t, http.StatusUnauthorized, code)
}

func TestLogin_KeepsAnotherUsersAccountWhenCreateReturnsItsID(t *testing.T) {
	api := &fakeAPI{}
	h := newHandler(t, api)
	demo := login(t, h, "demo")
	api.createID = demo.UserPublicID

	code, _ := call(t, h, http.MethodPost, "/login", "", `{"name": "other"}`)

	require.NotEqual(t, http.StatusOK, code)
	require.Empty(t, api.deleted, "nothing is rolled back, since the ID belongs to demo")
	users, err := LoadUsers(t.Context(), h.UsersPath)
	require.NoError(t, err)
	require.Len(t, users.Users, 1)
}

func TestLogin_SavesTheNewUserEvenIfTheClientDisconnects(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	api := &fakeAPI{onCreate: cancel}
	h := newHandler(t, api)

	req := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader(`{"name": "demo"}`)).WithContext(ctx)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	again := login(t, h, "demo")
	require.False(t, again.Created)
	require.Equal(t, []string{"demo"}, api.created)
	require.Empty(t, api.deleted)
}

func TestLogin_StopsWaitingForAnotherSignInWhenCanceled(t *testing.T) {
	started := make(chan struct{})
	finish := make(chan struct{})
	api := &fakeAPI{onCreate: func() {
		close(started)
		<-finish
	}}
	h := newHandler(t, api)
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/login", strings.NewReader(`{"name": "first"}`)))
	}()
	<-started

	ctx, cancel := context.WithCancel(context.Background())
	secondDone := make(chan int)
	go func() {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader(`{"name": "second"}`)).WithContext(ctx)
		h.ServeHTTP(rec, req)
		secondDone <- rec.Code
	}()
	cancel()
	select {
	case code := <-secondDone:
		require.Equal(t, http.StatusServiceUnavailable, code)
	case <-time.After(5 * time.Second):
		t.Fatal("the canceled sign-in kept waiting")
	}

	close(finish)
	<-firstDone
	require.Equal(t, []string{"first"}, api.created)
}

func TestHealth_AndWrongMethodOrPath(t *testing.T) {
	h := newHandler(t, &fakeAPI{})

	code, body := call(t, h, http.MethodGet, "/health", "", "")
	require.Equal(t, http.StatusOK, code)
	require.Equal(t, map[string]any{"status": "ok", "app_key": "app-key"}, body)

	code, _ = call(t, h, http.MethodGet, "/token", "", "")
	require.Equal(t, http.StatusMethodNotAllowed, code)
	code, _ = call(t, h, http.MethodPost, "/other", "", "")
	require.Equal(t, http.StatusNotFound, code)
}

func TestProjectAgent_RecordsTheFirstAgentAndReturnsItToEveryComputer(t *testing.T) {
	h := newHandler(t, &fakeAPI{})
	key := login(t, h, "demo").ConnectionKey

	code, none := call(t, h, http.MethodPost, "/project-agent", key, `{"project": "/Storyboard"}`)
	require.Equal(t, http.StatusOK, code)
	require.Equal(t, "", none["agent_id"])

	// Two computers each created an agent; the first one recorded wins.
	_, first := call(t, h, http.MethodPost, "/project-agent", key, `{"project": "/storyboard", "agent_id": "agent-1"}`)
	_, second := call(t, h, http.MethodPost, "/project-agent", key, `{"project": "/STORYBOARD", "agent_id": "agent-2"}`)
	_, lookup := call(t, h, http.MethodPost, "/project-agent", key, `{"project": "/storyboard"}`)

	require.Equal(t, "agent-1", first["agent_id"])
	require.Equal(t, "agent-1", second["agent_id"])
	require.Equal(t, "agent-1", lookup["agent_id"])
}

func TestProjectAgent_KeepsEachUsersAgentsSeparate(t *testing.T) {
	h := newHandler(t, &fakeAPI{})
	alice := login(t, h, "alice").ConnectionKey
	bob := login(t, h, "bob").ConnectionKey

	_, recorded := call(t, h, http.MethodPost, "/project-agent", alice, `{"project": "/storyboard", "agent_id": "agent-a"}`)
	require.Equal(t, "agent-a", recorded["agent_id"])
	_, res := call(t, h, http.MethodPost, "/project-agent", bob, `{"project": "/storyboard"}`)

	require.Equal(t, "", res["agent_id"])
}

func TestProjectAgent_RejectsBadRequests(t *testing.T) {
	h := newHandler(t, &fakeAPI{})
	key := login(t, h, "demo").ConnectionKey

	for name, tc := range map[string]struct {
		key, body string
		code      int
	}{
		"unknown key":     {"0000", `{"project": "/storyboard"}`, http.StatusUnauthorized},
		"nested project":  {key, `{"project": "/storyboard/shots"}`, http.StatusBadRequest},
		"relative path":   {key, `{"project": "storyboard"}`, http.StatusBadRequest},
		"agent ID spaces": {key, `{"project": "/storyboard", "agent_id": "a b"}`, http.StatusBadRequest},
		"unknown field":   {key, `{"project": "/storyboard", "x": 1}`, http.StatusBadRequest},
	} {
		t.Run(name, func(t *testing.T) {
			code, _ := call(t, h, http.MethodPost, "/project-agent", tc.key, tc.body)
			require.Equal(t, tc.code, code)
		})
	}
	users, err := LoadUsers(context.Background(), h.UsersPath)
	require.NoError(t, err)
	u, _ := users.Find("demo")
	require.Empty(t, u.Agents)
}
