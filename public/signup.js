(function () {
  var form = document.getElementById("signup");
  if (!form) return;
  var status = document.getElementById("signup-status");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var button = form.querySelector("button[type=submit]");
    button.disabled = true;
    status.textContent = "Sending.";
    fetch("/api/subscribe", {
      method: "POST",
      body: new FormData(form),
      headers: { accept: "application/json" },
    })
      .then(function (res) {
        return res.json().then(
          function (data) { return { res: res, data: data }; },
          function () { return { res: res, data: {} }; },
        );
      })
      .then(function (out) {
        if (out.res.status === 429) {
          status.textContent = out.data.error || "Too many tries. Please wait and try again.";
          return;
        }
        if (!out.res.ok || out.data.ok === false) {
          status.textContent = out.data.error || "Could not sign up. Try again.";
          return;
        }
        if (out.data.status === "unsubscribed") {
          status.textContent = "That address is unsubscribed. It was not added again.";
          return;
        }
        if (out.data.already) {
          status.textContent = "You're already on the list.";
          return;
        }
        status.textContent = "You're on the list for new boards and events.";
        form.reset();
      })
      .catch(function () {
        status.textContent = "Could not sign up. Try again.";
      })
      .then(function () {
        button.disabled = false;
      });
  });
})();
