// Command tokenserver creates managed users and mints their access tokens for
// the FolderSync sample app. It holds the app key and secret. In a real product
// this runs server-side; in the sample it runs next to the app, and the app's
// launcher (npm start, or start.sh in the zip file) starts and stops it.
//
//	tokenserver serve -app-key KEY -app-secret-stdin   # the launcher runs this
//	tokenserver list-users
//	tokenserver remove-user -name demo [-delete-account]
//
// Users sign in from the app by name; the first sign-in creates the managed user.
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"errors"
	"foldersync/tokenserver/tokenmint"
)

const usage = `Usage:
  tokenserver serve [-app-key KEY] [-app-secret-stdin] [-listen 127.0.0.1:8787] [-users FILE]
      Serves the app: GET /health, POST /login, POST /token, POST /delete-account,
      POST /project-agent.
      The app key comes from -app-key or DBX_APP_KEY. The app secret comes from
      stdin with -app-secret-stdin, or from DBX_APP_SECRET.
  tokenserver list-users [-users FILE]
      Lists the users, without their connection keys.
  tokenserver remove-user -name NAME [-delete-account] [-users FILE]
      Removes the user, so its connection key stops working. The managed user
      stays in Dropbox. With -delete-account, it also deletes the managed user
      and all its files from Dropbox, which can't be undone.

Users sign in from the app by name, which creates the managed user the first
time. The users file defaults to ~/.foldersync/tokenserver/users.json.
remove-user -delete-account reads DBX_APP_KEY and DBX_APP_SECRET.
`

// shutdownTimeout bounds waiting for requests in flight when the server is
// told to stop. It covers a whole sign-in, including rolling back a managed
// user it couldn't save, so stopping never leaves one behind.
const shutdownTimeout = tokenmint.MutationTimeout + 5*time.Second

// saveTimeout bounds saving the users file after a managed user was deleted.
const saveTimeout = 30 * time.Second

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		serve(os.Args[2:])
	case "list-users":
		listUsers(os.Args[2:])
	case "remove-user":
		removeUser(os.Args[2:])
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}

// signalContext is canceled on Ctrl-C or SIGTERM. Commands call it after
// reading stdin, so Ctrl-C at a prompt ends the program before anything changed.
func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

func defaultUsersPath() string {
	path, err := tokenmint.DefaultUsersPath(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	return path
}

func appClient(endpoint, appKey, appSecret string) *tokenmint.AppClient {
	if appKey == "" || appSecret == "" {
		log.Fatal("the app key and app secret are required")
	}
	return &tokenmint.AppClient{
		Client:    &http.Client{Timeout: 30 * time.Second},
		Endpoint:  endpoint,
		AppKey:    appKey,
		AppSecret: appSecret,
		Scopes:    tokenmint.UserScopes,
		Now:       time.Now,
	}
}

func envAppClient(endpoint string) *tokenmint.AppClient {
	return appClient(endpoint, os.Getenv("DBX_APP_KEY"), os.Getenv("DBX_APP_SECRET"))
}

func serve(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	listen := fs.String("listen", "127.0.0.1:8787", "loopback address to listen on")
	usersPath := fs.String("users", defaultUsersPath(), "users file")
	endpoint := fs.String("endpoint", tokenmint.DefaultEndpoint, "Dropbox API origin")
	appKey := fs.String("app-key", os.Getenv("DBX_APP_KEY"), "Dropbox app key")
	secretStdin := fs.Bool("app-secret-stdin", false, "read the app secret from the first line of stdin")
	_ = fs.Parse(args)
	// The server holds the app secret and signs in by name only, so it answers
	// only this computer.
	if host, _, err := net.SplitHostPort(*listen); err != nil || !tokenmint.IsLoopbackHost(host) {
		log.Fatalf("-listen must be a loopback address such as 127.0.0.1:8787, not %q", *listen)
	}

	appSecret := os.Getenv("DBX_APP_SECRET")
	if *secretStdin {
		line, err := readLine()
		if err != nil && line == "" {
			log.Fatalf("read the app secret from stdin: %v", err)
		}
		appSecret = strings.TrimSpace(line)
	}
	// Canceled on Ctrl-C or SIGTERM, which stops the server.
	ctx, stop := signalContext()
	defer stop()
	client := appClient(*endpoint, *appKey, appSecret)

	log.Printf("checking the app key and secret with Dropbox...")
	checkCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	err := client.CheckCredentials(checkCtx)
	cancel()
	var apiErr *tokenmint.APIError
	if errors.As(err, &apiErr) {
		log.Fatalf("Dropbox didn't accept the app key and secret: %s", apiErr.Summary)
	}
	if err != nil {
		log.Fatalf("Couldn't reach Dropbox (api.dropboxapi.com) to check the app key and secret: %v. Check your network or proxy.", err)
	}

	handler := &tokenmint.Handler{Dropbox: client, UsersPath: *usersPath, AppKey: *appKey, Now: time.Now}
	server := &http.Server{
		Addr:              *listen,
		Handler:           tokenmint.LoopbackOnly(handler),
		ReadHeaderTimeout: 10 * time.Second,
		// Bounds reading a request body, so a stalled client can't hold a handler.
		ReadTimeout: 30 * time.Second,
		// Requests see shutdown as cancellation, so queued sign-ins don't start.
		BaseContext: func(net.Listener) context.Context { return ctx },
	}

	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		// Let requests in flight finish, so users.json is saved.
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()

	log.Printf("token server listening on http://%s (users in %s)", *listen, *usersPath)
	serveErr := server.ListenAndServe()
	// Release the shutdown goroutine whatever stopped the server, and wait for
	// it: ListenAndServe returns as soon as Shutdown starts.
	stop()
	<-shutdownDone
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		log.Fatalf("serve: %v", serveErr)
	}
	log.Printf("token server stopped")
}

func listUsers(args []string) {
	fs := flag.NewFlagSet("list-users", flag.ExitOnError)
	usersPath := fs.String("users", defaultUsersPath(), "users file")
	_ = fs.Parse(args)
	ctx, stop := signalContext()
	defer stop()

	users, err := tokenmint.LoadUsers(ctx, *usersPath)
	if err != nil {
		log.Fatalf("load users: %v", err)
	}
	if len(users.Users) == 0 {
		fmt.Printf("No users in %s.\n", *usersPath)
		return
	}
	for _, u := range users.Users {
		fmt.Printf("%s\t%s\tadded %s\n", u.Name, u.UserPublicID, u.CreatedAt.Format(time.RFC3339))
	}
}

func removeUser(args []string) {
	fs := flag.NewFlagSet("remove-user", flag.ExitOnError)
	name := fs.String("name", "", "the user to remove (required)")
	deleteAccount := fs.Bool("delete-account", false, "also delete the managed user and all its files from Dropbox; can't be undone")
	usersPath := fs.String("users", defaultUsersPath(), "users file")
	endpoint := fs.String("endpoint", tokenmint.DefaultEndpoint, "Dropbox API origin")
	_ = fs.Parse(args)
	if *name == "" {
		log.Fatal("-name is required")
	}

	users, err := tokenmint.LoadUsers(context.Background(), *usersPath)
	if err != nil {
		log.Fatalf("load users: %v", err)
	}
	user, ok := users.Find(*name)
	if !ok {
		log.Fatalf("%s has no user named %q. See the users with: tokenserver list-users", *usersPath, *name)
	}
	if *deleteAccount {
		fmt.Printf("This permanently deletes the Dropbox account %s and all its files.\nType the user name (%s) to confirm: ", user.UserPublicID, user.Name)
		answer, err := readLine()
		// EOF is fine after a name without a newline, such as from a pipe.
		if err != nil && !(errors.Is(err, io.EOF) && answer != "") {
			log.Fatalf("read the confirmation: %v; nothing was changed", err)
		}
		if strings.TrimSpace(answer) != user.Name {
			log.Fatal("not confirmed; nothing was changed")
		}
	}
	ctx, stop := signalContext()
	defer stop()
	if *deleteAccount {
		deleteCtx, cancel := context.WithTimeout(ctx, time.Minute)
		defer cancel()
		// Delete in Dropbox first, so a failure leaves the local entry for a retry.
		if err := envAppClient(*endpoint).DeleteUser(deleteCtx, user.UserPublicID); err != nil {
			log.Fatalf("delete managed user: %v", err)
		}
		fmt.Printf("Deleted the managed user %s from Dropbox.\n", user.UserPublicID)
	}
	saveCtx := ctx
	if *deleteAccount {
		// The user is gone from Dropbox, so finish removing the record even after Ctrl-C.
		var cancel context.CancelFunc
		saveCtx, cancel = context.WithTimeout(context.WithoutCancel(ctx), saveTimeout)
		defer cancel()
	}
	removed := false
	err = tokenmint.UpdateUsers(saveCtx, *usersPath, func(f *tokenmint.UsersFile) error {
		// By key: a sign-in may have replaced the user with a new one meanwhile.
		_, removed = f.RemoveByKey(user.ConnectionKey)
		return nil
	})
	if err != nil {
		log.Fatalf("save users: %v", err)
	}
	if !removed {
		fmt.Printf("%s changed while this ran, so its entry was left as is.\n", user.Name)
		return
	}
	fmt.Printf("Removed %s. Its connection key no longer works.\n", user.Name)
	if !*deleteAccount {
		fmt.Printf("The managed user %s is still in Dropbox, but nothing can sign in to it now. Signing in as %q from the app creates a new one.\n", user.UserPublicID, user.Name)
	}
}

// readLine reads a line from stdin. Call it before signalContext, so Ctrl-C
// ends the program while it waits. Callers say what they were reading.
func readLine() (string, error) {
	return bufio.NewReader(os.Stdin).ReadString('\n')
}
