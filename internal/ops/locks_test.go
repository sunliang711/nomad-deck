package ops

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestCrossedSharedAndExclusiveNoDeadlock(t *testing.T) {
	m := NewLockManager()
	for i := 0; i < 30; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)

		hold, err := m.Acquire(ctx, []LockReq{{Key: "k1", Mode: Shared}})
		if err != nil {
			cancel()
			t.Fatalf("iter %d initial acquire: %v", i, err)
		}

		var wg sync.WaitGroup
		wg.Add(2)
		errs := make(chan error, 2)

		go func() {
			defer wg.Done()
			rel, err := m.Acquire(ctx, []LockReq{{Key: "k1", Mode: Exclusive}, {Key: "k2", Mode: Shared}})
			if err != nil {
				errs <- err
				return
			}
			time.Sleep(time.Millisecond)
			rel()
		}()
		// Give waiter A a brief head start so it queues ahead of B on k1.
		time.Sleep(2 * time.Millisecond)

		go func() {
			defer wg.Done()
			rel, err := m.Acquire(ctx, []LockReq{{Key: "k1", Mode: Shared}, {Key: "k2", Mode: Exclusive}})
			if err != nil {
				errs <- err
				return
			}
			time.Sleep(time.Millisecond)
			rel()
		}()
		time.Sleep(2 * time.Millisecond)

		hold()
		wg.Wait()
		cancel()
		close(errs)
		for err := range errs {
			t.Fatalf("iter %d crossed lock acquire failed: %v", i, err)
		}
		if m.Busy("k1") || m.Busy("k2") {
			t.Fatalf("iter %d leaked lock busy state: k1=%v k2=%v", i, m.Busy("k1"), m.Busy("k2"))
		}
	}
}
