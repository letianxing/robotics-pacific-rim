//go:build pacific_rim_ros2_rclgo

package ros2

/*
#cgo LDFLAGS: "-L/opt/ros/humble/lib" "-Wl,-rpath=/opt/ros/humble/lib"
#cgo CFLAGS: "-I/opt/ros/humble/include/rcl"
#cgo CFLAGS: "-I/opt/ros/humble/include/rmw"
#cgo CFLAGS: "-I/opt/ros/humble/include/rosidl_runtime_c"
#cgo CFLAGS: "-I/opt/ros/humble/include/rosidl_typesupport_interface"
#cgo CFLAGS: "-I/opt/ros/humble/include/rcutils"
#cgo CFLAGS: "-I/opt/ros/humble/include/rcl_action"
#cgo CFLAGS: "-I/opt/ros/humble/include/action_msgs"
#cgo CFLAGS: "-I/opt/ros/humble/include/unique_identifier_msgs"
#cgo CFLAGS: "-I/opt/ros/humble/include/builtin_interfaces"
#cgo CFLAGS: "-I/opt/ros/humble/include/rcl_yaml_param_parser"
#cgo LDFLAGS: "-L/opt/ros/jazzy/lib" "-Wl,-rpath=/opt/ros/jazzy/lib"
#cgo CFLAGS: "-I/opt/ros/jazzy/include/rcl"
#cgo CFLAGS: "-I/opt/ros/jazzy/include/rmw"
#cgo CFLAGS: "-I/opt/ros/jazzy/include/rosidl_runtime_c"
#cgo CFLAGS: "-I/opt/ros/jazzy/include/rosidl_typesupport_interface"
#cgo CFLAGS: "-I/opt/ros/jazzy/include/rcutils"
#cgo CFLAGS: "-I/opt/ros/jazzy/include/rcl_action"
#cgo CFLAGS: "-I/opt/ros/jazzy/include/action_msgs"
#cgo CFLAGS: "-I/opt/ros/jazzy/include/unique_identifier_msgs"
#cgo CFLAGS: "-I/opt/ros/jazzy/include/builtin_interfaces"
#cgo CFLAGS: "-I/opt/ros/jazzy/include/rcl_yaml_param_parser"
#cgo LDFLAGS: -lrcl -lrmw -lrosidl_runtime_c -lrosidl_typesupport_c -lrcutils -lrcl_action -lrmw_implementation

#include <stdlib.h>
#include <string.h>

#include <rcl/rcl.h>
#include <rcutils/allocator.h>
#include <rmw/rmw.h>
#include <rosidl_runtime_c/message_type_support_struct.h>

static rmw_serialized_message_t pr_go_zero_serialized_message(void) {
  return rmw_get_zero_initialized_serialized_message();
}

static rcl_ret_t pr_go_serialized_message_init(
  rmw_serialized_message_t *msg,
  size_t size
) {
  rcutils_allocator_t allocator = rcl_get_default_allocator();
  rcl_ret_t rc = rcutils_uint8_array_init(msg, size, &allocator);
  if (rc != RCL_RET_OK) {
    return rc;
  }
  msg->buffer_length = msg->buffer_capacity;
  return RCL_RET_OK;
}

static rcl_ret_t pr_go_serialized_message_fini(rmw_serialized_message_t *msg) {
  return rcutils_uint8_array_fini(msg);
}

static void pr_go_serialized_message_copy(
  rmw_serialized_message_t *msg,
  const void *data,
  size_t size
) {
  if (size > 0 && data != NULL) {
    memcpy(msg->buffer, data, size);
  }
}

static rcl_ret_t pr_go_rmw_serialize(
  const void *ros_message,
  const rosidl_message_type_support_t *type_support,
  rmw_serialized_message_t *serialized_message
) {
  return rmw_serialize(ros_message, type_support, serialized_message);
}

static rcl_ret_t pr_go_rmw_deserialize(
  rmw_serialized_message_t *serialized_message,
  const rosidl_message_type_support_t *type_support,
  void *ros_message
) {
  return rmw_deserialize(serialized_message, type_support, ros_message);
}
*/
import "C"

import (
	"errors"
	"fmt"
	"unsafe"

	"github.com/tiiuae/rclgo/pkg/rclgo/types"
)

func serializeTypedMessage(msg types.Message) ([]byte, error) {
	typeSupport := msg.GetTypeSupport()
	cmsg := typeSupport.PrepareMemory()
	defer typeSupport.ReleaseMemory(cmsg)
	typeSupport.AsCStruct(cmsg, msg)

	serialized := C.pr_go_zero_serialized_message()
	if rc := C.pr_go_serialized_message_init(&serialized, 0); rc != C.RCL_RET_OK {
		return nil, fmt.Errorf("initialize ROS2 serialized message: rcl error %d", int(rc))
	}
	defer C.pr_go_serialized_message_fini(&serialized)

	if rc := C.pr_go_rmw_serialize(
		cmsg,
		(*C.rosidl_message_type_support_t)(typeSupport.TypeSupport()),
		&serialized,
	); rc != C.RCL_RET_OK {
		return nil, fmt.Errorf("serialize ROS2 typed message: rmw error %d", int(rc))
	}
	if serialized.buffer_length == 0 {
		return nil, nil
	}
	out := C.GoBytes(unsafe.Pointer(serialized.buffer), C.int(serialized.buffer_length))
	return out, nil
}

func deserializeTypedMessage(payload []byte, typeSupport types.MessageTypeSupport) (types.Message, error) {
	if typeSupport == nil {
		return nil, errors.New("ROS2 message type support is nil")
	}
	serialized := C.pr_go_zero_serialized_message()
	if rc := C.pr_go_serialized_message_init(&serialized, C.size_t(len(payload))); rc != C.RCL_RET_OK {
		return nil, fmt.Errorf("initialize ROS2 serialized message: rcl error %d", int(rc))
	}
	defer C.pr_go_serialized_message_fini(&serialized)
	if len(payload) > 0 {
		C.pr_go_serialized_message_copy(&serialized, unsafe.Pointer(&payload[0]), C.size_t(len(payload)))
	}

	cmsg := typeSupport.PrepareMemory()
	defer typeSupport.ReleaseMemory(cmsg)
	if rc := C.pr_go_rmw_deserialize(
		&serialized,
		(*C.rosidl_message_type_support_t)(typeSupport.TypeSupport()),
		cmsg,
	); rc != C.RCL_RET_OK {
		return nil, fmt.Errorf("deserialize ROS2 typed message: rmw error %d", int(rc))
	}
	msg := typeSupport.New()
	typeSupport.AsGoStruct(msg, cmsg)
	return msg, nil
}
