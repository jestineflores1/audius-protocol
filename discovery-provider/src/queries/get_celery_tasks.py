import logging
from datetime import datetime

import pytz
from src.monitors import monitor_names, monitors
from src.utils.prometheus_metric import PrometheusMetric, PrometheusType

logger = logging.getLogger(__name__)
MONITORS = monitors.MONITORS


# Returns active celery tasks
def get_celery_tasks():
    celery_tasks = monitors.get_monitors(
        [
            MONITORS[monitor_names.celery_tasks],
        ]
    )

    return celery_tasks


def convert_epoch_to_datetime(epoch):
    utc_dt = datetime.utcfromtimestamp(epoch).replace(tzinfo=pytz.utc)
    tz = pytz.timezone("America/New_York")  # keep US east as default timezone
    dt = utc_dt.astimezone(tz)
    return dt


def celery_tasks_prometheus_exporter():

    tasks = get_celery_tasks()["celery_tasks"]

    metric = PrometheusMetric(
        "celery_running_tasks",
        "The currently running celery tasks",
        labelnames=["task_name"],
        metric_type=PrometheusType.GAUGE,
    )

    for task in tasks:
        try:
            metric.save_time(
                {"task_name": task["task_name"]}, start_time=task["started_at"]
            )
        except:
            logger.exception(f"Processing failed for task: {task}")


PrometheusMetric.register_collector(
    "celery_tasks_prometheus_exporter", celery_tasks_prometheus_exporter
)
