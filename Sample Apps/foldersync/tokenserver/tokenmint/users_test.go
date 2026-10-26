package tokenmint

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"errors"
)

func TestUsers_AddSaveAndLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.json")

	users, err := LoadUsers(t.Context(), path)
	require.NoError(t, err)
	require.Empty(t, users.Users)

	var a, b User
	require.NoError(t, UpdateUsers(t.Context(), path, func(f *UsersFile) error {
		var err error
		if a, err = f.Add("alice", "pid_user:a", fixedNow); err != nil {
			return err
		}
		b, err = f.Add("bob", "pid_user:b", fixedNow)
		return err
	}))
	require.Len(t, a.ConnectionKey, 64)
	require.NotEqual(t, a.ConnectionKey, b.ConnectionKey)

	info, err := os.Stat(path)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0o600), info.Mode().Perm())
	leftovers, err := filepath.Glob(path + ".tmp*")
	require.NoError(t, err)
	require.Empty(t, leftovers)

	loaded, err := LoadUsers(t.Context(), path)
	require.NoError(t, err)
	require.Equal(t, &UsersFile{Users: []User{a, b}}, loaded)
	found, ok := loaded.FindByKey(b.ConnectionKey)
	require.True(t, ok)
	require.Equal(t, b, found)
	_, ok = loaded.FindByKey("")
	require.False(t, ok)
}

func TestUpdateUsers_DiscardsChangesWhenUpdateFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tokenserver", "users.json")
	require.NoError(t, UpdateUsers(t.Context(), path, func(f *UsersFile) error {
		_, err := f.Add("alice", "pid_user:a", fixedNow)
		return err
	}))
	before, err := os.ReadFile(path)
	require.NoError(t, err)
	errStop := errors.New("stop")

	err = UpdateUsers(t.Context(), path, func(f *UsersFile) error {
		_, err := f.Add("bob", "pid_user:b", fixedNow)
		require.NoError(t, err)
		return errStop
	})

	require.ErrorIs(t, err, errStop)
	after, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, before, after)
}

func TestValidateName(t *testing.T) {
	for _, name := range []string{"demo", "Jane Doe", "team.video-1_a", "데모"} {
		require.NoError(t, ValidateName(name), name)
	}
	for _, name := range []string{"", " demo", "demo ", "a/b", "../x", "x\\y"} {
		require.Error(t, ValidateName(name), name)
	}
}

func TestValidateProject(t *testing.T) {
	for _, project := range []string{"/storyboard", "/My Shots", "/데모", "/.hidden"} {
		require.NoError(t, ValidateProject(project), project)
	}
	for _, project := range []string{"", "/", "storyboard", "/a/b", "/.", "/..", "/a\x00b", "/a\nb", "/a\u007fb"} {
		require.Error(t, ValidateProject(project), project)
	}
}

func TestValidateName_CountsCharactersNotBytes(t *testing.T) {
	for _, letter := range []string{"a", "é", "가"} {
		require.NoError(t, ValidateName(strings.Repeat(letter, 64)), letter)
		require.Error(t, ValidateName(strings.Repeat(letter, 65)), letter)
	}
}

func TestDefaultUsersPath(t *testing.T) {
	path, err := DefaultUsersPath(func(key string) string {
		if key == "FOLDERSYNC_HOME" {
			return "/tmp/fs"
		}
		return ""
	})
	require.NoError(t, err)
	require.Equal(t, "/tmp/fs/tokenserver/users.json", path)
}

func TestUsers_RejectsADuplicateName(t *testing.T) {
	users := &UsersFile{}
	_, err := users.Add("demo", "pid_user:a", fixedNow)
	require.NoError(t, err)

	require.True(t, users.Has("demo"))
	_, err = users.Add("demo", "pid_user:b", fixedNow)
	require.ErrorContains(t, err, `a user named "demo" already exists`)
	require.Len(t, users.Users, 1)
}

func TestUsers_RemoveByKey(t *testing.T) {
	users := &UsersFile{}
	a, err := users.Add("alice", "pid_user:a", fixedNow)
	require.NoError(t, err)
	_, err = users.Add("bob", "pid_user:b", fixedNow)
	require.NoError(t, err)

	removed, ok := users.RemoveByKey(a.ConnectionKey)
	require.True(t, ok)
	require.Equal(t, a, removed)
	require.False(t, users.Has("alice"))
	require.True(t, users.Has("bob"))

	_, ok = users.RemoveByKey(a.ConnectionKey)
	require.False(t, ok)
	_, ok = users.RemoveByKey("")
	require.False(t, ok)
}

func TestLoadUsers_RejectsInvalidOrRepeatedEntries(t *testing.T) {
	key1 := strings.Repeat("a", 64)
	key2 := strings.Repeat("b", 64)
	entry := func(name, id, key string) string {
		return `{"name": "` + name + `", "user_public_id": "` + id + `", "connection_key": "` + key + `", "created_at": "2026-10-22T00:00:00Z"}`
	}
	for name, tc := range map[string]struct{ users, want string }{
		"no connection key": {`{"name": "x", "user_public_id": "pid_user:x", "created_at": "2026-10-22T00:00:00Z"}`, "invalid connection_key"},
		"short key":         {entry("x", "pid_user:x", "abcd"), "invalid connection_key"},
		"no public ID":      {entry("x", "", key1), "no user_public_id"},
		"bad name":          {entry("a/b", "pid_user:x", key1), `entry "a/b"`},
		"same name":         {entry("x", "pid_user:x", key1) + "," + entry("x", "pid_user:y", key2), "repeats"},
		"same public ID":    {entry("x", "pid_user:x", key1) + "," + entry("y", "pid_user:x", key2), "repeats"},
		"same key":          {entry("x", "pid_user:x", key1) + "," + entry("y", "pid_user:y", key1), "repeats"},
		"nested project":    {`{"name": "x", "user_public_id": "pid_user:x", "connection_key": "` + key1 + `", "created_at": "2026-10-22T00:00:00Z", "agents": {"/a/b": "agent-1"}}`, "invalid project"},
		"uppercase project": {`{"name": "x", "user_public_id": "pid_user:x", "connection_key": "` + key1 + `", "created_at": "2026-10-22T00:00:00Z", "agents": {"/Storyboard": "agent-1"}}`, "invalid project"},
		"empty agent ID":    {`{"name": "x", "user_public_id": "pid_user:x", "connection_key": "` + key1 + `", "created_at": "2026-10-22T00:00:00Z", "agents": {"/storyboard": ""}}`, "invalid agent ID"},
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "users.json")
			require.NoError(t, os.WriteFile(path, []byte(`{"users": [`+tc.users+`]}`), 0o600))

			_, err := LoadUsers(t.Context(), path)

			require.ErrorContains(t, err, tc.want)
		})
	}
}

func TestLoadUsers_AcceptsValidEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.json")
	users := `{"name": "x", "user_public_id": "pid_user:x", "connection_key": "` + strings.Repeat("a", 64) + `", "created_at": "2026-10-22T00:00:00Z"}`
	require.NoError(t, os.WriteFile(path, []byte(`{"users": [`+users+`]}`), 0o600))

	f, err := LoadUsers(t.Context(), path)

	require.NoError(t, err)
	require.Len(t, f.Users, 1)
}

func TestUsers_ClaimAgentKeepsTheFirstAgent(t *testing.T) {
	f := &UsersFile{}
	u, err := f.Add("demo", "pid_user:demo", fixedNow)
	require.NoError(t, err)

	first, err := f.ClaimAgent(u.ConnectionKey, "/storyboard", "agent-1")
	require.NoError(t, err)
	second, err := f.ClaimAgent(u.ConnectionKey, "/storyboard", "agent-2")
	require.NoError(t, err)
	_, err = f.ClaimAgent(strings.Repeat("0", 64), "/storyboard", "agent-3")

	require.Equal(t, "agent-1", first)
	require.Equal(t, "agent-1", second)
	require.ErrorContains(t, err, "unknown connection key")
	require.NoError(t, f.validate())
}
