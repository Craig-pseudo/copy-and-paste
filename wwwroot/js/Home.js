window.initDropdown = function () {

    // -------------------------
    // Site dropdown
    // -------------------------

    const siteButton = document.querySelector(
        '[data-action="toggle-dropdown"]'
    );

    const siteDropdown = document.querySelector(
        '.dropdown-menu'
    );

    if (siteButton && siteDropdown) {

        siteButton.addEventListener("click", function () {

            siteDropdown.classList.toggle("hidden");

        });

    }
     

    // -------------------------
    // Notification dropdown
    // -------------------------

    const notificationButton = document.querySelector(
        '#dropdownNotificationButton'
    );

    const notificationDropdown = document.querySelector(
        '#dropdownNotification'
    );

    if (notificationButton && notificationDropdown) {

        notificationButton.addEventListener("click", function () {

            notificationDropdown.classList.toggle("hidden");

        });

    }


    // -------------------------
    // Group By dropdown
    // -------------------------

    const groupButton = document.querySelector(
        '[data-action="toggle-group-dropdown"]'
    );

    const groupDropdown = document.querySelector(
        '.group-dropdown-menu'
    );

    if (groupButton && groupDropdown) {

        groupButton.addEventListener("click", function () {

            groupDropdown.classList.toggle("hidden");

        });

    }

};

// Get the CSS variable --color-brand and convert it to hex for ApexCharts
const getBrandColor = () => {
    // Get the computed style of the document's root element
    const computedStyle = getComputedStyle(document.documentElement);

    // Get the value of the --color-brand CSS variable
    return computedStyle.getPropertyValue('--color-fg-brand').trim() || "#1447E6";
};

const getBrandSecondaryColor = () => {
    const computedStyle = getComputedStyle(document.documentElement);
    return computedStyle.getPropertyValue('--color-fg-brand-subtle').trim() || "#1447E6";
};

const brandColor = getBrandColor();
const brandSecondaryColor = getBrandSecondaryColor();

const options = {
    // set the labels option to true to show the labels on the X and Y axis
    xaxis: {
        show: true,
        categories: ['01 Feb', '02 Feb', '03 Feb', '04 Feb', '05 Feb', '06 Feb', '07 Feb'],
        labels: {
            show: true,
            style: {
                fontFamily: "Inter, sans-serif",
                cssClass: 'text-xs font-normal fill-body'
            }
        },
        axisBorder: {
            show: false,
        },
        axisTicks: {
            show: false,
        },
    },
    yaxis: {
        show: true,
        labels: {
            show: true,
            style: {
                fontFamily: "Inter, sans-serif",
                cssClass: 'text-xs font-normal fill-body'
            },
            formatter: function (value) {
                return '$' + value;
            }
        }
    },
    series: [
        {
            name: "Developer Edition",
            data: [150, 141, 145, 152, 135, 125],
            color: brandColor,
        },
        {
            name: "Designer Edition",
            data: [43, 13, 65, 12, 42, 73],
            color: brandSecondaryColor,
        },
    ],
    chart: {
        sparkline: {
            enabled: false
        },
        height: "100%",
        width: "100%",
        type: "area",
        fontFamily: "Inter, sans-serif",
        dropShadow: {
            enabled: false,
        },
        toolbar: {
            show: false,
        },
    },
    tooltip: {
        enabled: true,
        x: {
            show: false,
        },
    },
    fill: {
        type: "gradient",
        gradient: {
            opacityFrom: 0.55,
            opacityTo: 0,
            shade: brandColor,
            gradientToColors: [brandColor],
        },
    },
    dataLabels: {
        enabled: false,
    },
    stroke: {
        width: 6,
    },
    legend: {
        show: false
    },
    grid: {
        show: false,
    },
}

if (document.getElementById("labels-chart") && typeof ApexCharts !== 'undefined') {
    const chart = new ApexCharts(document.getElementById("labels-chart"), options);
    chart.render();
}



window.telemetryCharts = {

    displacement: null,

    renderDisplacement: function () {

        const element = document.querySelector("#displacement-chart");

        if (!element) {
            console.error("displacement-chart element not found");
            return;
        }

        // Destroy an existing chart before creating another one.
        if (this.displacement) {
            this.displacement.destroy();
            this.displacement = null;
        }

        const options = {

            series: [
                {
                    name: "Displacement",

                    data: [
                        [Date.parse("2026-09-21T07:00:00"), 9.6],
                        [Date.parse("2026-09-21T07:15:00"), 9.9],
                        [Date.parse("2026-09-21T07:30:00"), 10.0],
                        [Date.parse("2026-09-21T07:45:00"), 12.0]
                    ]
                }
            ],

            chart: {
                type: "line",
                height: 240,

                toolbar: {
                    show: false
                }
            },

            colors: ["#ef4444"],

            stroke: {
                width: 3,
                curve: "smooth"
            },

            markers: {
                size: 4
            },

            xaxis: {
                type: "datetime",

                labels: {
                    datetimeUTC: false,
                    format: "HH:mm"
                }
            },

            yaxis: {
                min: 0,
                max: 20,

                labels: {
                    formatter: function (value) {
                        return value.toFixed(0) + " mm";
                    }
                }
            },

            annotations: {
                yaxis: [
                    {
                        y: 15,

                        borderColor: "#f59e0b",
                        strokeDashArray: 4,

                        label: {
                            borderColor: "#f59e0b",

                            style: {
                                color: "#fff",
                                background: "#f59e0b"
                            },

                            text: "Alarm 15 mm"
                        }
                    }
                ]
            },

            tooltip: {
                x: {
                    format: "HH:mm"
                },

                y: {
                    formatter: function (value) {
                        return value.toFixed(1) + " mm";
                    }
                }
            },

            grid: {
                borderColor: "#e5e7eb",
                strokeDashArray: 4
            }
        };

        this.displacement =
            new ApexCharts(element, options);

        this.displacement.render();
    }
};