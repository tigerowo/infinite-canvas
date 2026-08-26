package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/service"
)

func main() {
	if runtime.GOOS != "darwin" {
		log.Fatal("CLI helper 仅支持 macOS")
	}
	if err := config.Load(); err != nil {
		log.Fatal(err)
	}
	if !config.Cfg.CLIHelperEnabled {
		log.Fatal("CLI_HELPER_ENABLED 未启用")
	}
	socketPath := strings.TrimSpace(config.Cfg.CLIHelperSocket)
	if err := validateSocketDirectory(socketPath); err != nil {
		log.Fatal(err)
	}
	lifetime, stopLoginProcesses := context.WithCancel(context.Background())
	defer stopLoginProcesses()
	handler, err := service.NewCLICompanionHandler(lifetime)
	if err != nil {
		log.Fatal("CLI helper 安全配置无效")
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		log.Fatal("CLI helper Unix Socket 启动失败；请确认不存在旧进程或遗留 Socket")
	}
	listener.SetUnlinkOnClose(true)
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = listener.Close()
		log.Fatal("CLI helper Unix Socket 权限设置失败")
	}
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       8 * time.Second,
		WriteTimeout:      8 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	serverError := make(chan error, 1)
	go func() {
		serverError <- server.Serve(listener)
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-serverError:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Print("CLI helper 服务异常退出")
		}
	case <-stop:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}
}

func validateSocketDirectory(socketPath string) error {
	if socketPath == "" || !filepath.IsAbs(socketPath) {
		return errors.New("CLI_HELPER_SOCKET 必须是绝对路径")
	}
	directory := filepath.Dir(socketPath)
	info, err := os.Stat(directory)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return errors.New("CLI helper Socket 目录必须已存在且仅当前用户可访问")
	}
	return nil
}
