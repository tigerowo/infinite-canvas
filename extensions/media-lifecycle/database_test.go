package medialifecycle

import (
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/go-sql-driver/mysql"
	gormmysql "gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Integration tests allocate a disposable database/schema per test. The fixed
// container hostnames prevent accidentally applying fixture cleanup elsewhere.
func lifecycleTestDB(t *testing.T, sqlitePath string) *gorm.DB {
	t.Helper()
	driver, dsn := os.Getenv("EXT_MEDIA_LIFECYCLE_TEST_DRIVER"), os.Getenv("EXT_MEDIA_LIFECYCLE_TEST_DSN")
	options := &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)}
	var dialector gorm.Dialector = sqlite.Open(sqlitePath)
	if driver != "" && driver != "sqlite" {
		schema := "mltest_" + strings.ReplaceAll(ID(), "-", "")
		var admin *gorm.DB
		var err error
		switch driver {
		case "postgres":
			u, parseErr := url.Parse(dsn)
			if parseErr != nil || u.Hostname() != "lifecycle-test-postgres" {
				t.Fatal("integration tests require the isolated PostgreSQL container")
			}
			admin, err = gorm.Open(postgres.Open(dsn), options)
			if err != nil {
				t.Fatal(err)
			}
			if err := admin.Exec("CREATE SCHEMA " + schema).Error; err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := admin.Exec("DROP SCHEMA " + schema + " CASCADE").Error; err != nil {
					t.Error(err)
				}
				sql, _ := admin.DB()
				sql.Close()
			})
			query := u.Query()
			query.Set("search_path", schema)
			u.RawQuery = query.Encode()
			dialector = postgres.Open(u.String())
		case "mysql":
			cfg, parseErr := mysql.ParseDSN(dsn)
			if parseErr != nil || cfg.Net != "tcp" || cfg.Addr != "lifecycle-test-mysql:3306" {
				t.Fatal("integration tests require the isolated MySQL container")
			}
			admin, err = gorm.Open(gormmysql.Open(dsn), options)
			if err != nil {
				t.Fatal(err)
			}
			if err := admin.Exec("CREATE DATABASE " + schema + " CHARACTER SET utf8mb4").Error; err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := admin.Exec("DROP DATABASE " + schema).Error; err != nil {
					t.Error(err)
				}
				sql, _ := admin.DB()
				sql.Close()
			})
			cfg.DBName = schema
			dialector = gormmysql.Open(cfg.FormatDSN())
		default:
			t.Fatal("unsupported test database")
		}
	}
	db, err := gorm.Open(dialector, options)
	if err != nil {
		t.Fatal(err)
	}
	sql, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sql.Close() })
	return db
}
